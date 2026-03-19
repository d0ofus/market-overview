# TODO

## Overview
- Add multiple chart view of commodities
- Add RS chart (like my google sheets dashboard)
- Check on EW sectors column data

## Breadth
- Scoring for market breadth for overall 
- Add other more bespoke breadth metrics
- Make EOD timing after market but before Aus wake up
- Add in Chart of S&P with mcllean oscillator
- Define Overall Universe (worden universe) so that those rows are accurate

## 13F Tracker
- Automatic weekly/monthly pull of data for 13F 
- Add dropdown list for 13F filings to choose hedge fund
- Add other funds to track like Drunkenmiller

## Sector Tracker
- Add number of constituents when clicking pop up
- Change the source of URA to get the .csv from https://assets.globalxetfs.com/funds/holdings/ura_full-holdings_20260309.csv
- Check on source of 1D % change. For example, many names in MSOS is not showing the correct % change in the ETF constituents pop up list

## Alerts
- For industry peers view, change to liteweight charts

## Peer Groups
- Continue the seeding of tickers
- Remove XYZ._ tickers
- Show % change and market cap on each chart

## Scans
- Add weekly gainers scan
- Add strongest FA scan
- Add Strong earnings scanner
- Colour by industry

## Scanning

## Watchlist Compiler
- Have a preset for 'Focus list - Ready for execution' + 'Focus list - Close to ready', and show multi-chart view + news + ranking (marketsurge score?)

## Gappers
- Find out what the current filters are and add more scanning filters or use a preset 
- Add $ on gap = Pre Vol * Price
- Add Average $ traded filter
- Remove ETFs, only stocks
- Sign up for an LLM to test it out

## Admin
- Adding in Sector ETF XPH doesn't show up on overview, but there is another section below to add. Have the ETF watchlists portion be the source of truth 
- Shows pending for ETFs like JETS, but ETF consituent sync status shows 'pending', 0 records and No cached data. Clicking on it shows contituents, and checking the DB shows all ok.
- Check why most ETFs limited to 25 tickers
- ETFs that need to be checked
> IBIT
> WGMI
> ARKK: More than 25 components (https://www.ark-funds.com/funds/arkk#hold)

## General
- Change default of pop ups to sort by 1D% change
- Add small logo on the webpage for each page. For e.g. Gappers can show 'G'
- Make it such that hover over the tab in the browser would show which page it is
- Add momentum monitor like https://x.com/_Adi_B_/status/2029634187624693843/photo/1
- Add in search function for leveraged ETFs
- Remove whitespaces and use more space for charts
- Add news impact page (on dashboard(?))
- Add scanners compilation as a new page --> Use share screen and link (e.g. https://www.tradingview.com/screener/DH50xwYA/) to get watchlist
- See what other features in google sheets that is good
- Add Calendar of US holidays
- Check on whether cloudflare database is sustainable
> Remove backlog and use more snapshot cache to keep database sustainable

