# TODO

## Overview
- Add multiple chart view of commodities
- Add RS chart (like my google sheets dashboard)
- Check on EW sectors column data

## Breadth
- Scoring for market breadth for overall 
- Add other more bespoke breadth metrics
- Add in Chart of S&P with mcllean oscillator
- Define Overall Universe (worden universe) so that those rows are accurate

## 13F Tracker
- Automatic weekly/monthly pull of data for 13F 
- Add dropdown list for 13F filings to choose hedge fund
- Add other funds to track like Drunkenmiller

## Sector Tracker
- Change the source of URA to get the .csv from https://assets.globalxetfs.com/funds/holdings/ura_full-holdings_20260309.csv
- Check on source of 1D % change. For example, many names in MSOS is not showing the correct % change in the ETF constituents pop up list

## Alerts
- For industry peers view, change to liteweight charts

## Peer Groups
- Continue the seeding of tickers
- Remove XYZ._ tickers
- Learn how to add/remove tickers from peer groups

## Scans
- Add weekly gainers scan
- Add strongest FA scan
- Add Strong earnings scanner
- Colour by industry
- Add ability to ingest tickers from watchlist compiler and run scan like Within 5EMA
- Add Jeff Sun weekly scan
- Add Qullamaggie weekly scan

## Scanning

## Watchlist Compiler
- Have a preset for 'Focus list - Ready for execution' + 'Focus list - Close to ready', and show multi-chart view + news + ranking (marketsurge score?)

## Gappers
- Find out what the current filters are and add more scanning filters or use a preset 
- Add $ on gap = Pre Vol * Price
- Add Average $ traded filter
- Remove ETFs, only stocks
- Sign up for an LLM to test it out
- Add highest pre-market volume scan

## Admin
- Adding in Sector ETF XPH doesn't show up on overview, but there is another section below to add. Have the ETF watchlists portion be the source of truth 
- Shows pending for ETFs like JETS, but ETF consituent sync status shows 'pending', 0 records and No cached data. Clicking on it shows contituents, and checking the DB shows all ok.
- Check why most ETFs limited to 25 tickers
- ETFs that need to be checked
> IBIT
> WGMI
> ARKK: More than 25 components (https://www.ark-funds.com/funds/arkk#hold)

## General
- Add research using AI on dashboard for any ticker
- Add polymarket overview like (https://www.perplexity.ai/computer/a/f87a4860-4de3-4184-96fb-a1da94a68b38?view=split)
- Add page to search for latest macroeconomic analysis (including charts)
- Add momentum monitor like https://x.com/_Adi_B_/status/2029634187624693843/photo/1
- Add in search function for leveraged ETFs
- Add news impact page (on dashboard(?))
- See what other features in google sheets that is good
- Add Calendar of US holidays
- Check on whether cloudflare database is sustainable
> Remove backlog and use more snapshot cache to keep database sustainable
