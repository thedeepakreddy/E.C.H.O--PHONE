/** Convert the backup's hourly forecasts to Echo's units without inventing missing measurements. */
const CODES = { clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45, lightrain: 61, rain: 63, heavyrain: 65,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82, lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86, lightsleet: 68, sleet: 68, heavysleet: 69,
  lightsleetshowers: 68, sleetshowers: 68, heavysleetshowers: 69 };
export function invalidWeather() { return Object.assign(new Error("Invalid weather response."), { name: "WeatherDataError" }); }
export function metWeather(data, now) {
  const units = data?.properties?.meta?.units;
  if (units?.air_temperature !== "celsius" || units.wind_speed !== "m/s") throw invalidWeather();
  if (!Array.isArray(data?.properties?.timeseries)) throw invalidWeather();
  const rows = data.properties.timeseries.map((r) => ({ ...r, at: Date.parse(r.time) })).filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const current = rows.filter((r) => r.at <= now).at(-1) ?? rows[0];
  if (!current || Math.abs(current.at - now) > 90 * 60_000) throw invalidWeather();
  const end = current.at + 24 * 3600_000;
  const nextDay = rows.filter((r) => r.at >= current.at && r.at <= end);
  const temperatures = nextDay.map((r) => r.data?.instant?.details?.air_temperature).filter(Number.isFinite);
  if (temperatures.length < 20 || temperatures.length !== nextDay.length || nextDay.at(-1)?.at < end - 3600_000) throw invalidWeather();
  const instant = current.data?.instant?.details;
  if (!Number.isFinite(instant?.air_temperature)) throw invalidWeather();
  const symbol = current.data?.next_1_hours?.summary?.symbol_code ?? current.data?.next_6_hours?.summary?.symbol_code ?? "";
  const condition = symbol.replace(/_(day|night|polartwilight)$/, "");
  const code = condition.includes("thunder") ? 95 : CODES[condition] ?? null;
  return { temp: instant.air_temperature, feels: null, humidity: instant.relative_humidity ?? null,
    wind: Number.isFinite(instant.wind_speed) ? Math.round(instant.wind_speed * 3.6 * 10) / 10 : null,
    code, isDay: /_(day|polartwilight)$/.test(symbol), high: Math.max(...temperatures), low: Math.min(...temperatures), timezone: null,
    forecastPeriod: "next_24_hours", forecastAt: current.time,
    source: "MET Norway", sourceUrl: "https://api.met.no/", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  };
}
