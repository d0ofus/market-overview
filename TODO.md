# TODO

## Overview
- Fix sparklines
- Add macro stuff like 10Y yields
- Add yield curve structure
- Amend implied rate path to intervals of 0.1% on the y-axis
- Add refresh button for macro rates table
- Check on EW sectors column data
- Put the same EW Sector ETF on the same row as the non-EW one. Sort by non-EW
- Add proper tickers for global indices like KOSPI, and use data fallback from FMPm, yfinance, or EODHD 
- Add RS chart (like my google sheets dashboard)

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
- Change the source of URA to get the .csv from https://assets.globalxetfs.com/funds/holdings/ura_full-holdings_20260309.csv
- Check on source of 1D % change. For example, many names in MSOS is not showing the correct % change in the ETF constituents pop up list

## Alerts
- Add day of the week to subtitles for multi-grid
- For industry peers view, change to liteweight charts

## Peer Groups
- Remove XYZ._ tickers
- Learn how to add/remove tickers from peer groups

## Scans
- Add RS scan
- Add strongest FA scan
- Add Strong earnings scanner
- Colour by industry
- Add ability to ingest tickers from watchlist compiler and run scan like Within 5EMA

## Watchlist Compiler
- Add ranking system for compiled names - Use perplexity/AI with API

## Gappers
- Remove ETFs, closed ended funds, and OTC tickers
- Find out what the current filters are and add more scanning filters or use a preset 
- Add $ on gap = Pre Vol * Price
- Add Average $ traded filter
- Add highest pre-market volume scan

## Admin
- Adding in Sector ETF XPH doesn't show up on overview, but there is another section below to add. Have the ETF watchlists portion be the source of truth 
- Shows pending for ETFs like JETS, but ETF consituent sync status shows 'pending', 0 records and No cached data. Clicking on it shows contituents, and checking the DB shows all ok.
- Check why most ETFs limited to 25 tickers
>> ETFs that need to be checked
> IBIT
> WGMI
> ARKK: More than 25 components (https://www.ark-funds.com/funds/arkk#hold)

## General
- See what other features in google sheets dashboard that are good
- Remove top left Market command centre box

## AI Research
- Add ability to assess Relative strength to index
- add in analyst recommendations and analyst reports analysis as well

## New Functions
- Add in search function for leveraged ETFs
- Add news impact page (on dashboard(?))
- Add page to search for latest macroeconomic analysis (including charts)
- Add polymarket overview like (https://www.perplexity.ai/computer/a/f87a4860-4de3-4184-96fb-a1da94a68b38?view=split)
- Add momentum monitor like https://x.com/_Adi_B_/status/2029634187624693843/photo/1
- Add Calendar of US holidays
