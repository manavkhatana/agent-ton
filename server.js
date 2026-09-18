import express from "express";
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.static("."));

const PORT = process.env.PORT || 3000;

let browser;
let page;

async function startBrowser() {
  browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext();
  page = await context.newPage();
}

async function searchWeb(query) {
  await page.goto(
    `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    { waitUntil: "domcontentloaded" }
  );

  return await page.locator("body").innerText();
}

async function createFile(filename, content) {
  const safeName = path.basename(filename);
  const dir = path.resolve("Pg/workspace");

  await fs.mkdir(dir, { recursive: true });

  const file = path.join(dir, safeName);
  await fs.writeFile(file, content, "utf8");

  return file;
}

app.post("/agent", async (req, res) => {
  try {
    const { action, query, filename, content } = req.body;

    if (action === "search") {
      const result = await searchWeb(query);

      return res.json({
        success: true,
        result
      });
    }

    if (action === "createFile") {
      const file = await createFile(filename, content);

      return res.json({
        success: true,
        file
      });
    }

    if (action === "open") {
      await page.goto(query, {
        waitUntil: "domcontentloaded"
      });

      return res.json({
        success: true,
        title: await page.title(),
        text: (await page.locator("body").innerText()).slice(0, 20000)
      });
    }

    res.status(400).json({
      success: false,
      error: "Unknown action"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, async () => {
  await startBrowser();
  console.log(`Agent running on port ${PORT}`);
});