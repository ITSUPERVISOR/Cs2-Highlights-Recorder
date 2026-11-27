/** Semantic tones for match performance numbers. */
export type StatTone = "good" | "mid" | "bad" | "neutral";

export function toneClass(tone: StatTone): string {
  switch (tone) {
    case "good":
      return "text-success";
    case "bad":
      return "text-danger";
    case "mid":
      return "text-amber";
    default:
      return "text-muted";
  }
}

export function barToneClass(tone: StatTone): string {
  switch (tone) {
    case "good":
      return "bg-success";
    case "bad":
      return "bg-danger";
    case "mid":
      return "bg-amber";
    default:
      return "bg-muted";
  }
}

/** CS-ish ADR bands (per-map average damage). */
export function adrTone(adr: number): StatTone {
  if (adr >= 85) return "good";
  if (adr >= 65) return "mid";
  return "bad";
}

/** K/D ratio from kills and deaths. */
export function kdTone(kills: number, deaths: number): StatTone {
  const kd = deaths <= 0 ? kills : kills / deaths;
  if (kd >= 1.2) return "good";
  if (kd >= 0.85) return "mid";
  return "bad";
}

/** HLTV-style rating bands. */
export function ratingTone(rating: number): StatTone {
  if (rating >= 1.15) return "good";
  if (rating >= 0.9) return "mid";
  return "bad";
}

/** More highlight clips is better; zero stays muted. */
export function clipsTone(count: number): StatTone {
  if (count <= 0) return "neutral";
  if (count >= 8) return "good";
  if (count >= 3) return "mid";
  return "bad";
}
