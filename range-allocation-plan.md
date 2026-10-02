# Range Allocation Plan

This plan spreads the non-skipped subcategory ranges evenly across the four live TradersPost accounts based on:
- **Range formation time** (`range_window` start)
- **Stop-loss size in ticks** (`stop_loss_ticks_cents / 100` when `stop_loss_style = ticks`)

Skipped subcategories: MW, Water or Wine, Random Gain28, Ninja Turtles

## Summary

- Total ranges reviewed: 62
- Ranges placed: 29
- Ranges ignored: 33

### Allocation

| Account | Ranges | Instruments | Subcategories | Avg Start | Avg SL (ticks) | Total SL (ticks) |
|---|---|---|---|---|---|---|
| B&B 76 | 7 | GC1!, MNQ1!, NQ1! | B&B, Emerald Hedge, Luck of the Irish, Nathans Hotdogs, Uncategorized | 10:23 | 76.00 | 532.00 |
| DIAMOND | 7 | MGC1!, MNQ1!, NQ1! | B&B, Emerald Hedge, Nathans Hotdogs, Uncategorized | 09:33 | 53.29 | 373.00 |
| MW 82 | 7 | MGC1!, MNQ1!, NQ1! | B&B, Diamond, Luck of the Irish, Nathans Hotdogs | 12:06 | 77.43 | 542.00 |
| Nate | 8 | MGC1!, MNQ1!, NQ1! | Diamond, Emerald Hedge, Luck of the Irish, Nathans Hotdogs | 11:38 | 41.50 | 332.00 |

## Model: B&B 76

| Range | Subcategory | Instrument | Window | Start | TP Style | SL Style | SL Ticks |
|---|---|---|---|---|---|---|---|
| GOLD TEST | Uncategorized | GC1! | 0000-0000 | 00:00 | Ticks | Ticks | 0.00 |
| Test Range | Nathans Hotdogs | NQ1! | 0210-0224 | 02:10 | ticks | ticks | 20.00 |
| B&B XC | B&B | NQ1! | 0730-1000 | 07:30 | Ticks | Ticks | 201.00 |
| BUFFET 2.0 | Emerald Hedge | MNQ1! | 0830-2000 | 08:30 | ticks | ticks | 40.00 |
| B&B NINA BUCK SUNDAY | B&B | NQ1! | 1800-1900 | 18:00 | Ticks | Ticks | 151.00 |
| 46 CODE | Luck of the Irish | MNQ1! | 1802-1801 | 18:02 | ticks | ticks | 60.00 |
| FULL DAY 1830 | Luck of the Irish | MNQ1! | 1831-1830 | 18:31 | ticks | ticks | 60.00 |

## Model: DIAMOND

| Range | Subcategory | Instrument | Window | Start | TP Style | SL Style | SL Ticks |
|---|---|---|---|---|---|---|---|
| TV TUESDAY | Uncategorized | MNQ1! | 0000-0000 | 00:00 | Ticks | Ticks | 0.00 |
| 3-1-9 40/60 | Emerald Hedge | MNQ1! | 0300-1900 | 03:00 | ticks | ticks | 60.00 |
| BREAKFAST | Nathans Hotdogs | MNQ1! | 0800-0815 | 08:00 | 1x | 1/4x | n/a |
| TOMAHAWK | Emerald Hedge | MNQ1! | 0822-2028 | 08:22 | ticks | ticks | 60.00 |
| B&B M&M | B&B | NQ1! | 1100-1200 | 11:00 | Ticks | Ticks | 170.00 |
| V3X GOLD | Nathans Hotdogs | MGC1! | 1800-2230 | 18:00 | Ticks | 1x | n/a |
| B&B NINA QODE 40 SUNDAY | B&B | NQ1! | 1830-2000 | 18:30 | Ticks | Ticks | 83.00 |

## Model: MW 82

| Range | Subcategory | Instrument | Window | Start | TP Style | SL Style | SL Ticks |
|---|---|---|---|---|---|---|---|
| B&B MATRIX | B&B | NQ1! | 0200-0800 | 02:00 | Ticks | Ticks | 201.00 |
| B&B R5 | B&B | NQ1! | 0730-0935 | 07:30 | Ticks | Ticks | 201.00 |
| V3X | Nathans Hotdogs | MNQ1! | 0815-0825 | 08:15 | Ticks | 1x | n/a |
| CC 963 | Luck of the Irish | MNQ1! | 0900-1830 | 09:00 | ticks | ticks | 100.00 |
| DIAMOND GOLDEN OPPORTUNITY 1X | Diamond | MGC1! | 1800-2230 | 18:00 | 1x | 1x | n/a |
| ASIA | Nathans Hotdogs | NQ1! | 1806-1809 | 18:06 | 1.5x | 1/2x | n/a |
| DYNAMITE V3 | Luck of the Irish | MNQ1! | 2155-1916 | 21:55 | ticks | ticks | 40.00 |

## Model: Nate

| Range | Subcategory | Instrument | Window | Start | TP Style | SL Style | SL Ticks |
|---|---|---|---|---|---|---|---|
| MATRIX 2 | Nathans Hotdogs | NQ1! | 0200-0800 | 02:00 | Ticks | Ticks | 40.00 |
| 6-8 78 | Nathans Hotdogs | NQ1! | 0600-0800 | 06:00 | Ticks | 1x | n/a |
| DIAMOND XC 2X | Diamond | NQ1! | 0730-1000 | 07:30 | Ticks | Ticks | 101.00 |
| DIAMOND EBE | Diamond | NQ1! | 0830-1030 | 08:30 | Ticks | Ticks | 41.00 |
| EGGS | Luck of the Irish | MNQ1! | 1100-1900 | 11:00 | ticks | ticks | 60.00 |
| GOLDEN OPPORTUNITY LITE | Luck of the Irish | MGC1! | 1800-2230 | 18:00 | 1/2x | 1/2x | n/a |
| 49 CODE | Luck of the Irish | MNQ1! | 1809-1804 | 18:09 | ticks | ticks | 60.00 |
| DIAMOND TIGER | Emerald Hedge | MGC1! | 2200-0800 | 22:00 | ticks | ticks | 30.00 |

## Ignored Ranges

| Range | Subcategory | Instrument | Window | SL Style | SL Ticks |
|---|---|---|---|---|---|
| 44 CODE | Random Gain28 | MNQ1! | 2200-1804 | ticks | 60.00 |
| 6-8 1x | Random Gain28 | NQ1! | 0600-0800 | 1x | n/a |
| 6-8 2:1 | Random Gain28 | NQ1! | 0600-0800 | Ticks | 100.00 |
| 6-8 3x | Random Gain28 | NQ1! | 0600-0800 | 1x | n/a |
| 6-830 1x | Random Gain28 | NQ1! | 0600-0830 | 1x | n/a |
| 6-830 3x | Random Gain28 | NQ1! | 0600-0830 | 1x | n/a |
| ASIA 7PM | Water or Wine | NQ1! | 1900-1903 | 1/2x | n/a |
| B&B NINA QODE 70 SUNDAY | Water or Wine | NQ1! | 1830-2000 | Ticks | 83.00 |
| BUCKS LIGHT | Water or Wine | MNQ1! | 1800-1900 | Ticks | 40.00 |
| GOLDEN OPPORTUNITY 1/2X | Random Gain28 | MGC1! | 1800-2230 | 1x | n/a |
| GOLDEN OPPORTUNITY 2X | Random Gain28 | MGC1! | 1800-2230 | 1x | n/a |
| LIGHT BREAKFAST | Water or Wine | MNQ1! | 0800-0815 | 1/4x | n/a |
| MW 13 CODE NQ1! | MW | NQ1! | 0300-1000 | ticks | 360.00 |
| MW 22-8 | MW | NQ1! | 2200-0800 | ticks | 201.00 |
| MW 68 NQ1! | MW | NQ1! | 0600-0800 | ticks | 200.00 |
| MW AE OIL FIBS CL1! | MW | CL1! | 0600-0830 | 1x | n/a |
| MW BUFFET | MW | NQ1! | 2200-0830 | ticks | 201.00 |
| MW G68 | MW | MGC1! | 0600-0830 | Ticks | 60.00 |
| MW GHOST | MW | NQ1! | 1300-1400 | ticks | 200.00 |
| MW GOLD CODE | MW | MGC1! | 2100-0000 | Ticks | 60.00 |
| MW M&M OSR | MW | NQ1! | 1100-1200 | 1x | n/a |
| MW NINA BUCK NQ | MW | NQ1! | 1800-1845 | ticks | 80.00 |
| MW NQ ORB | MW | NQ1! | 0930-1000 | Ticks | 200.00 |
| MW R5 | MW | NQ1! | 0730-0935 | ticks | 200.00 |
| MW RAT ORB | MW | NQ1! | 0945-0955 | ticks | 200.00 |
| MW Z CODE | MW | ZL1! | 0330-0930 | ticks | 30.00 |
| NINA DAILY | Water or Wine | MNQ1! | 1900-1905 | Ticks | 40.00 |
| R200 | Water or Wine | MNQ1! | 0730-0935 | Ticks | 200.00 |
| RUPTURE | Ninja Turtles | SIL1! | 0827-0830 | 10% | n/a |
| RUPTURE GOLD | Ninja Turtles | MGC1! | 0827-0830 | 10% | n/a |
| SATOSHI | Random Gain28 | MBT1! | 0100-0500 | 1x | n/a |
| TIGER KING | Water or Wine | MGC1! | 2200-0800 | Ticks | 30.00 |
| V4X | Random Gain28 | NQ1! | 0915-0925 | 1x | n/a |

## Notes

- Subcategories are taken from `range_subcategory_assignments` in the local DB.
- Ranges without a subcategory were treated as `Uncategorized` and placed.
- Ranges with a `stop_loss_style` other than `ticks` have unknown absolute SL sizes, so they were balanced by formation time only.
- The average start time per account is the mean of the range-formation start times (UTC HH:MM).