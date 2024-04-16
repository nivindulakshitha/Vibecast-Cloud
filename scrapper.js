const chromium = require('chromium');
const puppeteer = require("puppeteer-core");

async function scrapeData(spotifyUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath: chromium.path, headless: true });
        const page = await browser.newPage();

        await page.goto("https://spotifymate.com/");
        await page.type("#url", spotifyUrl);

        await page.click("#send");
        await page.bringToFront();
        await page.waitForSelector(".abuttons a");
        const downloadHref = await page.$eval(".abuttons a", element => element.getAttribute("href"));

        return downloadHref;
    } catch (err) {
        console.error('\t(Scrpe)', err.message);
        return false;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

module.exports = { scrapeData };