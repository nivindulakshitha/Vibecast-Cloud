const chromium = require('chromium');
const fetch = require('node-fetch');
const puppeteer = require("puppeteer-core");
const fs = require('fs');

async function scrapeData(songId, spotifyUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath: chromium.path, headless: true });
        const page = await browser.newPage();
        await page.goto("https://spotifydown.com/");
        await page.waitForSelector('input[placeholder="https://open.spotify.com/..../...."]');
        await page.type('input[placeholder="https://open.spotify.com/..../...."]', spotifyUrl);

        await page.waitForSelector('button[type="submit"]');
        await page.click('button[type="submit"]');

        const downloadHref = await new Promise(async (resolve, reject) => {
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));

                await page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight); // Scroll one viewport height down
                });

                await new Promise(resolve => setTimeout(resolve, 1000));

                await page.waitForSelector('#__next > div > div.mt-5.m-auto.text-center > div.mb-12.grid.grid-cols-1.gap-3.m-auto > div > div.flex.items-center.justify-end > button', { visible: true });
                await page.click('#__next > div > div.mt-5.m-auto.text-center > div.mb-12.grid.grid-cols-1.gap-3.m-auto > div > div.flex.items-center.justify-end > button');

                await page.waitForSelector('a[download]');

                const downloadHref = await page.$eval('a[download]', element => element.getAttribute('href'));

                resolve(downloadHref);
            } catch (error) {
                reject(error);
            }
        });


        await downloadBlob(browser, downloadHref, `${songId}.mp3`)

        return `${songId}.mp3`;
    } catch (err) {
        console.error('\t(Scrape)', err);
        return false;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function downloadBlob(browser, blobUrl, filePath) {
    const page = await browser.newPage();

    try {
        await page.goto(blobUrl);
        const blobData = await page.evaluate(async () => {
            const blob = new Blob([new Uint8Array(await (await fetch(window.location.href)).arrayBuffer())]);
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        });
        const data = blobData.split(',')[1];
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    } catch (error) {
        console.error('Error downloading Blob content:', error);
    } finally {
        await browser.close();
    }
}

module.exports = { scrapeData };