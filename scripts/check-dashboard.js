#!/usr/bin/env node
const path = require('path');
const puppeteer = require('puppeteer');

async function main() {
  const baseUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  const consoleMessages = [];
  const networkSummaries = [];
  const pageErrors = [];
  page.on('console', async (msg) => {
    const entry = { type: msg.type(), text: msg.text() };
    if (msg.args()?.length) {
      try {
        entry.details = await Promise.all(
          msg.args().map(async (arg) => {
            try {
              return await arg.jsonValue();
            } catch (_) {
              return null;
            }
          })
        );
      } catch (_) {
        // ignore serialization issues
      }
    }
    consoleMessages.push(entry);
  });
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.startsWith(baseUrl)) return;
    const summary = {
      url: url.replace(baseUrl, ''),
      status: response.status(),
      ok: response.ok(),
      method: response.request().method()
    };
    networkSummaries.push(summary);
  });
  page.on('pageerror', (err) => {
    pageErrors.push({ message: err.message, stack: err.stack });
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('#login-form', { timeout: 15000 });
    await page.type('#login-usuario', process.env.DASHBOARD_USER || 'admin');
    await page.type('#login-password', process.env.DASHBOARD_PASSWORD || 'changeme');
    await page.click('#login-submit');

    await page.waitForSelector('body:not(.auth-pending)', { timeout: 15000 });

  await page.waitForSelector('#records-table tbody', { timeout: 15000 });
    const rowTexts = await page.$$eval('#records-table tbody tr', (rows) => rows.map((row) => row.textContent.trim()));

    const dashboardState = await page.evaluate(() => {
      const tableBody = document.querySelector('#records-table tbody');
      return {
        authPending: document.body.classList.contains('auth-pending'),
        feedback: document.getElementById('feedback')?.textContent?.trim() || null,
        tableInnerHtml: tableBody ? tableBody.innerHTML : null,
        tabCount: document.querySelectorAll('.entity-tabs .tab-button').length,
        activeModule: document.querySelector('.entity-tabs .tab-button.active')?.dataset.module || null
      };
    });

    const screenshotPath = path.join(process.cwd(), 'dashboard-preview.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log('Dashboard cargado. Filas en la tabla:', rowTexts.length);
    console.log('Contenido de filas:', rowTexts);
    if (networkSummaries.length) {
      console.log('Respuestas obtenidas:', networkSummaries);
    }
    if (consoleMessages.length) {
      console.log('Mensajes de consola:', consoleMessages);
    }
    if (pageErrors.length) {
      console.log('Errores de página:', pageErrors);
    }
    console.log('Estado del dashboard:', dashboardState);
    console.log('Se guardó una captura en', screenshotPath);
  } catch (error) {
    const screenshotPath = path.join(process.cwd(), 'dashboard-preview-error.png');
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error('Se guardó captura de error en', screenshotPath);
    } catch (_) {
      // ignore
    }
    console.error('Fallo al validar el dashboard:', error);
    if (networkSummaries.length) {
      console.error('Respuestas obtenidas:', networkSummaries);
    }
    if (consoleMessages.length) {
      console.error('Mensajes de consola capturados:', consoleMessages);
    }
    if (pageErrors.length) {
      console.error('Errores de página:', pageErrors);
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
