# TODO
## PROBLEMS TO SOLVE
- No time to research on peers + individual company by the time watchlist is sorted

## GENERAL
> Check out whether there is any password login required and how to safeguard the repo/deployment since it is now a good app with many features
> Do a general cleanup of github repo and mark code properly for easy reference by LLMs
- See what other features in google sheets dashboard that are good
> For fundamental tabs, for foreign companies, search for 20-F = annual report or 6-K = foreign issuer reports, often used for quarterly earnings releases/results

## OVERVIEW
> Add pre-market analysis

> Check why macro rates not showing other timelines (1M, 3M, 6M ago)
> In ETF pop ups, highlight the 1D% change figure.
> Add macro stuff like 10Y yields and yield curve chart
- Check source of data for EQ Index Futures, they seem wrong.
- Add yield curve structure
- Amend implied rate path to intervals of 0.1% on the y-axis
- Add refresh button for macro rates table
- Check on EW sectors column data
- Put the same EW Sector ETF on the same row as the non-EW one. Sort by non-EW
- Add proper tickers for global indices like KOSPI, and use data fallback from FMPm, yfinance, or EODHD 

## BREADTH
> Check where the +4% and -4% data are coming from, doesn't look accurate referencing the stockbee page
- Add volume traded on majors as a breadth metric
- Add charts of hi/lo, new highs together with the EW charts
- Scoring for market breadth for overall 
- Add other more bespoke breadth metrics
- Add in Chart of S&P with mcllean oscillator
- Define Overall Universe (worden universe) so that those rows are accurate

## 13F TRACKER
- Automatic weekly/monthly pull of data for 13F 
- Add dropdown list for 13F filings to choose hedge fund
- Add other funds to track like Drunkenmiller

## SECTOR TRACKER
> Remove dropdown menu from tickers in new key movers tracker input
- Change the source of URA to get the .csv from https://assets.globalxetfs.com/funds/holdings/ura_full-holdings_20260309.csv
- Check on source of 1D % change. For example, many names in MSOS is not showing the correct % change in the ETF constituents pop up list

## ALERTS
> Find out why some companies are not filing with SEC for their quarterly earnings

## SOCIAL ALERTS
> Add scheduler for 12-hourly scrapes

## PEER GROUPS
> Integrate this with /admin to add the tickers into a new group
> Add earnings trend/quality ranker for any group. Sort by increasing rev/NI trend, then by accelerating/decelerating, and by beat/miss
- Remove OTC names like ABBNY, ABLZF etc.
- Remove XYZ._ tickers
- Learn how to add/remove tickers from peer groups

## CORRELATION
>> https://www.hiddenmetrix.com/guide/correlation-analysis/

## SCANS
> VCP and RS scans paused halfway, and only continue when I click the refresh scan button
> Make the UI better to segregate each input field
> Put a link to github docs (https://shner-elmo.github.io/TradingView-Screener/fields/stocks.html) or helper to find the Field ID for specific fields
> Put a preset for US market to have exchange, symbol type preconfigured
- Add strongest FA scan
- Colour by industry
- Add ability to ingest tickers from watchlist compiler and run scan like Within 5EMA

## PATTERN SCANNER
> Add in filter for min EPS % 

## EARNINGS
> Add multi-chart view
> ranked by distance of close from highs + volume multiple of average + % gain

## WATCHLIST COMPILER
> Make a function to rank by factors (e.g. price contraction, volume expansion, price > SMA200, increasing rev/NI trend etc.)

## GAPPERS
- Add avg traded volume column in table
- Change title to pre-market scan
- Remove ETFs, closed ended funds, and OTC tickers
- Find out what the current filters are and add more scanning filters or use a preset 
- Add $ on gap = Pre Vol * Price
- Add Average $ traded filter

## ADMIN
> Make it such that when user clicks on a selected group, the batch target changes to that group, 
> Add password protection to access admin
> Remove bootstrap seed batch function in peer groups
> Only can add 12 names, can't add in the rest
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
- Add macro dashboard (https://x.com/investingluc/status/2044560364424032433?s=20)
- Add unusual options analysis/insider transactions tracker
- Add in search function for leveraged ETFs
- Add news impact page (on dashboard(?))
- Add page to search for latest macroeconomic analysis (including charts)
- Add polymarket overview like (https://www.perplexity.ai/computer/a/f87a4860-4de3-4184-96fb-a1da94a68b38?view=split)
- Add momentum monitor like https://x.com/_Adi_B_/status/2029634187624693843/photo/1
- Add Calendar of US holidays

# API KEYS
Brave: Cryptonerdo123@gmail.com

Gemini: Cryptonerdo123@gmail.com
