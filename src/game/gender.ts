import type { Character, ReaderPronouns } from "./types.js";

// VE v0.9.2 src/shared/gender.ts. Old records default to she/her characters and a he/him reader.
export function genderOf(character: Pick<Character, "gender">) {
  return character.gender === "male" ? "male" : "female";
}

export function pronounsOf(character: Pick<Character, "gender">) {
  return genderOf(character) === "male"
    ? { they: "he", them: "him", their: "his", They: "He", Their: "His", partner: "boyfriend", tag: "he/him" }
    : { they: "she", them: "her", their: "her", They: "She", Their: "Her", partner: "girlfriend", tag: "she/her" };
}

export function readerPronounsOf(record: { playerPronouns?: unknown }): ReaderPronouns {
  return record.playerPronouns === "she" || record.playerPronouns === "they" ? record.playerPronouns : "he";
}

/** Normalize caption cues for matching while keeping the original caption for the image model. */
export function photoRuleText(text: string): string {
  return text.toLowerCase().replace(/\bhimself\b/g, "herself").replace(/\b(?:his|him)\b/g, "her").replace(/\bhe\b/g, "she");
}

/** Photo 1.9's anatomy filter for positive tags from older character records. */
export function genderedTags(tags: readonly string[], gender: "female" | "male"): string[] {
  return tags.filter(tag => {
    const plain = tag.replace(/^\((.*):[\d.]+\)$/, "$1").trim().toLowerCase().replace(/\s+/g, "_");
    if (gender === "male") {
      return !/^(?:\d+girls?|multiple_girls|female|mature_female|muscular_female|tall_female|female_pubic_hair|curvy)$/.test(plain) &&
        !/(?:^|_)(?:breasts?|pussy|vagina|vaginal|clitoris|areolae?|female_ejaculation)(?:_|$)/.test(plain);
    }
    return !/^(?:\d+boys?|multiple_boys|male_focus|mature_male|muscular_male|tall_male|male_pubic_hair|pectorals)$/.test(plain) &&
      !/(?:^|_)(?:penis|testicles)(?:_|$)/.test(plain);
  });
}
