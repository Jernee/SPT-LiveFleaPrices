import type { DependencyContainer } from "tsyringe";

import type { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import type { IPostDBLoadModAsync } from "@spt-aki/models/external/IPostDBLoadModAsync";
import type { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import type { RagfairPriceService } from "@spt-aki/services/RagfairPriceService";
import * as fs from "node:fs";
import * as path from "node:path";

class Mod implements IPostDBLoadModAsync
{
    private static container: DependencyContainer;
    private static updateTimer: NodeJS.Timeout;
    private static config: Config;
    private static configPath = path.resolve(__dirname, "../config/config.json");
    private static pricesPath = path.resolve(__dirname, "../config/prices.json");
    private static originalPrices;

    public async postDBLoadAsync(container: DependencyContainer): Promise<void> 
    {
        Mod.container = container;
        Mod.config = JSON.parse(fs.readFileSync(Mod.configPath, "utf-8"));

        // Store a clone of the original prices table, so we can make sure things don't go too crazy
        const databaseServer = Mod.container.resolve<DatabaseServer>("DatabaseServer");
        const priceTable = databaseServer.getTables().templates.prices;
        Mod.originalPrices = structuredClone(priceTable);

        // Update prices on startup
        if (!await Mod.updatePrices())
        {
            return;
        }
        // Setup a refresh interval to update once every hour
        Mod.updateTimer = setInterval(Mod.updatePrices, (60 * 60 * 1000));
    }

    static async fetchPrices(retries = 1): Promise<Record<string, number>>
    {
        const logger = Mod.container.resolve<ILogger>("WinstonLogger");
        const maxRetries = Mod.config.maxRetries
        let prices: Record<string, number>;

        // Try to fetch flea data and catch error if fetch fails.
        try 
        {
            logger.info("[LFP] Fetching Flea Prices...");
            const response = await fetch("https://raw.githubusercontent.com/DrakiaXYZ/SPT-LiveFleaPriceDB/main/prices.json");
            prices = await response.json();

            // Store the prices to disk for next time
            fs.writeFileSync(Mod.pricesPath, JSON.stringify(prices));

            // Update config file with the next update time
            Mod.config.nextUpdate = Math.floor(Date.now() / 1000) + 3600;
            fs.writeFileSync(Mod.configPath, JSON.stringify(Mod.config, null, 4));

            logger.info("[LFP] Successfully fetched flea prices.")
        } 
        // Catch errors thrown by fetch.
        catch (error)
        {
            if (retries <= maxRetries) 
            {
                logger.info("[LFP] Error fetching flea prices, retrying. Attempt #" + retries);
                return Mod.fetchPrices(retries + 1);
            }
            logger.info("[LFP] Retry count reached, stopping fetch attempts.");
            clearInterval(Mod.updateTimer);
            throw error
        }
        return prices;
    }

    static async updatePrices(): Promise<boolean>
    {
        const databaseServer = Mod.container.resolve<DatabaseServer>("DatabaseServer");
        const ragfairPriceService = Mod.container.resolve<RagfairPriceService>("RagfairPriceService");
        const priceTable = databaseServer.getTables().templates.prices; 
        const itemTable = databaseServer.getTables().templates.items;
        const handbookTable = databaseServer.getTables().templates.handbook;
        const logger = Mod.container.resolve<ILogger>("WinstonLogger");

        // Fetch prices.
        const prices = await Mod.fetchPrices();
        // Loop through the new prices file, updating all prices present
        logger.info("[LFP] Applying flea data to server.");
        for (const itemId in prices)
        {
            if (!itemTable[itemId])
            {
                continue;
            }

            let basePrice = Mod.originalPrices[itemId];
            if (!basePrice)
            {
                basePrice = handbookTable.Items.find(x => x.Id === itemId)?.Price ?? 0;
            }

            const maxPrice = basePrice * Mod.config.maxIncreaseMult;
            if (maxPrice !== 0 && prices[itemId] <= maxPrice)
            {
                priceTable[itemId] = prices[itemId];
            }
            else
            {
                logger.debug(`Setting ${itemId} to ${maxPrice} instead of ${prices[itemId]} due to over inflation`);
                priceTable[itemId] = maxPrice;
            }
        }

        // Update dynamic price cache. 
        // Note: We currently cast to `any` to bypass the protected state of the generateDynamicPrices method
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        (ragfairPriceService as any).generateDynamicPrices();

        logger.info("[LFP] Flea Prices Updated!");

        return true;
    }
}

interface Config 
{
    maxRetries: any;
    nextUpdate: number,
    maxIncreaseMult: number,
}

module.exports = { mod: new Mod() }