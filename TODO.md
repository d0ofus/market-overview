# TODO

## Overview
- Fix sparklines
- Check source of data for EQ Index Futures, they seem wrong.
- Add macro stuff like 10Y yields
- Add yield curve structure
- Amend implied rate path to intervals of 0.1% on the y-axis
- Add refresh button for macro rates table
- Check on EW sectors column data
- Put the same EW Sector ETF on the same row as the non-EW one. Sort by non-EW
- Add proper tickers for global indices like KOSPI, and use data fallback from FMPm, yfinance, or EODHD 

## Breadth
- Add volume traded on majors as a breadth metric
- Add charts of hi/lo, new highs together with the EW charts
- Scoring for market breadth for overall 
- Add other more bespoke breadth metrics
- Add in Chart of S&P with mcllean oscillator
- Define Overall Universe (worden universe) so that those rows are accurate

## 13F Tracker
- Automatic weekly/monthly pull of data for 13F 
- Add dropdown list for 13F filings to choose hedge fund
- Add other funds to track like Drunkenmiller

## Sector Tracker
> Change pop up window when clicking on sector/narrative calendar ticker to be a push out on the right that shows the chart, so that can click other tickers after without having to close a pop up
> Remove redundant info on sector/narrative claendar
> Increase the size of pop up window when clicking ETF constituents, to fit 3 in the pop up page
- Change the source of URA to get the .csv from https://assets.globalxetfs.com/funds/holdings/ura_full-holdings_20260309.csv
- Check on source of 1D % change. For example, many names in MSOS is not showing the correct % change in the ETF constituents pop up list

## Alerts
- For industry peers view, change to liteweight charts
- Shift paging and next button to the bottom of the pop up page when clicking on ticker

## Peer Groups
- Remove OTC names like ABBNY, ABLZF etc.
- Remove XYZ._ tickers
- Learn how to add/remove tickers from peer groups

## Correlation
>> https://www.hiddenmetrix.com/guide/correlation-analysis/
- Link correlation to peer groups

## Scans
- Add RS scan
- Add strongest FA scan
- Add Strong earnings scanner
- Colour by industry
- Add ability to ingest tickers from watchlist compiler and run scan like Within 5EMA

## Watchlist Compiler

## Gappers
- Add avg traded volume column in table
- Add highest pre-market volume scan, and change title to pre-market scan
- Remove ETFs, closed ended funds, and OTC tickers
- Find out what the current filters are and add more scanning filters or use a preset 
- Add $ on gap = Pre Vol * Price
- Add Average $ traded filter

## Admin
- Find out what slug means for peer-groups
- Add function to specific exchange before ticker. For e.g., OSX chart shows the ASX listing and not the NASDAQ one
- Adding in Sector ETF XPH doesn't show up on overview, but there is another section below to add. Have the ETF watchlists portion be the source of truth 
- Shows pending for ETFs like JETS, but ETF consituent sync status shows 'pending', 0 records and No cached data. Clicking on it shows contituents, and checking the DB shows all ok.
- Check why most ETFs limited to 25 tickers
>> ETFs that need to be checked
> IBIT
> WGMI
> ARKK: More than 25 components (https://www.ark-funds.com/funds/arkk#hold)
- Create export function to get all teh Industry and sector ETFs in the list
- Add/remove ETFs
>> Remove NWX

## General
- See what other features in google sheets dashboard that are good
- Remove top left Market command centre box

## Research Lab
==>> Make token use more efficient

- Add in embedded TV chart
- Add in comparison with peers (see peer-group groupings), analyse leader/laggard relationship with peers, performance comparison and whether the industry is trending
- Add in primary drivers analysis in synthesis layer. What are they and where they stand, and correlation
- Sort news by dates
- Add in current analyst consensus
- See what prompts are being used
- Link research with /peer-groups
- Add ability to assess Relative strength to index
- add in analyst recommendations and analyst reports analysis as well
- Create a research repository (maybe in peer-groups or new page?)

## New Functions
- Add in morning brief section using Claude API
- Add macro dashboard
- Add unusual options analysis/insider transactions tracker
- Add in search function for leveraged ETFs
- Add news impact page (on dashboard(?))
- Add page to search for latest macroeconomic analysis (including charts)
- Add polymarket overview like (https://www.perplexity.ai/computer/a/f87a4860-4de3-4184-96fb-a1da94a68b38?view=split)
- Add momentum monitor like https://x.com/_Adi_B_/status/2029634187624693843/photo/1
- Add Calendar of US holidays
