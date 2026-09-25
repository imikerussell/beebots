// Our own crypto / stock / commodity tagging. OKX has no field for this.
// Source: docs/xperps_eea_2026-09-24.json. Anything not listed is "unknown" and is never
// traded (logged at startup so it can be classified by hand). Stocks and commodities need
// ALLOW_NON_CRYPTO=true, which stays false until their trading hours are verified.

export type Kind = "crypto" | "stock" | "commodity" | "test" | "unknown";

const CRYPTO = new Set(
  "0G AAVE ACT ACU ADA AEON AERO AGLD AI ALGO ALLO APR APT ARB ARX ASTER ATOM AVAX AVNT BASED BCH BEAT BICO BILL BIO BNB BONK BSB BTC CAP CASHCAT CFX CHIP CNPY CP CRV DASH DGAI DOGE DOS DOT DYDX EDGE ENA ENSO ESP ETC ETH ETHFI FET FIL FLOCK GALA GRAM GRASS GRVT H HBAR HOME HYPE ICP INJ IOST IRYS JTO JUP KAITO KITE KMNO KSM LDO LINK LIT LTC MINA MON MOODENG MORPHO NEAR NES NIGHT NOT O OL ONDO ONT OP OPN ORDI PENDLE PENGU PEPE PIEVERSE POL PONS PROS PUMP PYTH RAVE RAY RE RENDER RESOLV RLS ROBO SAHARA SEI SHIB SLX SOL SOPH SPK STRK STX SUI SUSHI TAO TIA TRB TRIA TRUMP TRX UB UNI UP USELESS VIRTUAL VVV WIF WLD WLFI XLM XPL XRP YB ZAMA ZEC ZEN ZIL ZKP ZRO".split(" "),
);
const COMMODITY = new Set(["BZ", "CL", "XAG", "XAU"]);
const STOCK = new Set(
  "AAOI AAPL AMAT AMD AMZN ANTHROPIC ARM ASTS AVGO AXTI BE BMNR CBRS COHR COIN CRCL CRDO CRWV DELL DRAM EWY FLNC GLW GOOGL HOOD INTC IONQ IREN KO KORU LITE META MINIMAX MRNA MRVL MSFT MSTR MU MUU NBIS NVDA OKTA OPENAI ORCL PLTR QCOM QQQ RKLB SAMSUNG SKHY SKHYNIX SMCI SNDK SNXX SOFTBANK SOXL SOXS SPCX SPY TSLA TSM USAR WDC XIAOMI ZHIPU".split(" "),
);

export function kindOf(coin: string): Kind {
  if (coin.startsWith("TEST")) return "test";
  if (CRYPTO.has(coin)) return "crypto";
  if (COMMODITY.has(coin)) return "commodity";
  if (STOCK.has(coin)) return "stock";
  return "unknown";
}
