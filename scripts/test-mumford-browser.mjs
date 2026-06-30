#!/usr/bin/env node
/**
 * Browser test: upload Mumford confirmation screenshot → expect 2 stubs.
 *   node scripts/test-mumford-browser.mjs
 */
import { chromium } from "playwright";
import path from "path";

const imgPath = path.resolve(
  "/Users/negarghobadi/.cursor/projects/Users-negarghobadi-Documents-Projects/assets/Screenshot_2026-06-30_at_2.36.39_PM-761dd828-3190-410f-905f-7388b7b8ecea.png",
);
const base = "http://localhost:3456";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base);

await page.locator("#file-input").setInputFiles(imgPath);
await page.locator("#extract-btn").click();

await page.waitForFunction(
  () => {
    const status = document.querySelector("#status")?.textContent || "";
    return !status.includes("Reading") && !status.includes("OCR") && !status.includes("Preparing");
  },
  { timeout: 120000 },
);

const status = await page.locator("#status").textContent();
const articles = await page.locator(".tm").count();
const labels = await page.locator(".stub-ticket-label").allTextContents();
const section = await page.locator('[name="section"]').inputValue();
const row = await page.locator('[name="row"]').inputValue();
const seat = await page.locator('[name="seat"]').inputValue();
const orderCode = await page.locator('[name="orderCode"]').inputValue();
const artist = await page.locator('[name="eventLine2"]').inputValue();

console.log("Status:", status);
console.log("Form:", { section, row, seat, orderCode, artist });
console.log("Stubs:", articles, labels);

await page.screenshot({
  path: path.resolve("scripts/mumford-test-output.png"),
  fullPage: true,
});

await browser.close();

if (articles < 2) {
  console.error("FAIL: expected 2 stubs, got", articles);
  process.exit(1);
}
console.log("OK: multi-seat stubs rendered");
if (!seat.includes("15") || !seat.includes("16")) {
  console.warn("WARN: seat field may not show both seats:", seat);
}
