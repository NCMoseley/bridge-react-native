export function tradingViewInstrumentIconUrl(
  instrument: string | undefined,
): string {
  const normalized = instrument?.trim().toUpperCase() ?? ''
  const iconMap: Array<[RegExp, string]> = [
    [/^NQ/, 'https://s3-symbol-logo.tradingview.com/indices/nasdaq-100.svg'],
    [/^MNQ/, 'https://s3-symbol-logo.tradingview.com/country/US.svg'],
    [/^ES/, 'https://s3-symbol-logo.tradingview.com/indices/s-and-p-500.svg'],
    [/^MES/, 'https://s3-symbol-logo.tradingview.com/country/US.svg'],
    [/^YM/, 'https://s3-symbol-logo.tradingview.com/indices/dow-30.svg'],
    [/^MYM/, 'https://s3-symbol-logo.tradingview.com/country/US.svg'],
    [
      /^(RTY|M2K)/,
      'https://s3-symbol-logo.tradingview.com/indices/russell-2000.svg',
    ],
    [/^(GC|MGC)/, 'https://s3-symbol-logo.tradingview.com/metal/gold.svg'],
    [/^(SI|SIL)/, 'https://s3-symbol-logo.tradingview.com/metal/silver.svg'],
    [/^HG/, 'https://s3-symbol-logo.tradingview.com/metal/copper.svg'],
    [/^(CL|MCL)/, 'https://s3-symbol-logo.tradingview.com/crude-oil.svg'],
    [/^NG/, 'https://s3-symbol-logo.tradingview.com/natural-gas.svg'],
    [/^(BTC|MBT)/, 'https://s3-symbol-logo.tradingview.com/crypto/XTVCBTC.svg'],
    [/^ZL/, 'https://s3-symbol-logo.tradingview.com/commodity/soybean-oil.svg'],
  ]
  const matched = iconMap.find(([pattern]) => pattern.test(normalized))
  if (matched) return matched[1]
  const countryCode = normalized.startsWith('6A')
    ? 'AU'
    : normalized.startsWith('6B')
      ? 'GB'
      : normalized.startsWith('6C')
        ? 'CA'
        : normalized.startsWith('6E')
          ? 'EU'
          : normalized.startsWith('6J')
            ? 'JP'
            : normalized.startsWith('6N')
              ? 'NZ'
              : normalized.startsWith('6S')
                ? 'CH'
                : 'US'
  return `https://s3-symbol-logo.tradingview.com/country/${countryCode}.svg`
}


/** Display form for stored instruments: contract-expiry tickers render as the
 *  continuous contract so "MNQ 12-26" / "MNQZ26" both show as "MNQ1!". */
export function displayInstrument(instrument: string | undefined | null): string {
  if (!instrument) return '—'
  const t = instrument.trim().toUpperCase()
  if (t.endsWith('1!')) return t
  const spaced = t.match(/^([A-Z0-9!]+)\s+\d{2}-\d{2}$/)   // "MNQ 12-26", "6E 12-26"
  if (spaced) return `${spaced[1]}1!`
  const coded = t.match(/^([A-Z0-9]{1,4})[FGHJKMNQUVXZ]\d{1,2}$/)  // "MNQZ26", "6EZ26"
  if (coded) return `${coded[1]}1!`
  return t
}
