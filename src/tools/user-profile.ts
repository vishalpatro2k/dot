/**
 * User Profile
 *
 * Stores the user's name, work hours, communication preferences,
 * important people, and custom instructions. Persisted in SQLite KV.
 */

import { memory } from "../memory/store.js";

export interface UserProfile {
  name: string;
  nickname?: string;
  timezone?: string;
  workHoursStart: number;
  workHoursEnd: number;
  preferences: {
    useName: boolean;
    nameFrequency: "often" | "sometimes" | "rarely";
    communicationStyle: "casual" | "balanced" | "formal";
    emojiLevel: "none" | "minimal" | "normal";
  };
  importantPeople: Array<{
    name: string;
    relationship: string;
    notes?: string;
  }>;
  importantProjects: string[];
  customInstructions?: string;
}

const DEFAULT_PROFILE: UserProfile = {
  name: "there",
  workHoursStart: 9,
  workHoursEnd: 18,
  preferences: {
    useName: true,
    nameFrequency: "sometimes",
    communicationStyle: "casual",
    emojiLevel: "minimal",
  },
  importantPeople: [],
  importantProjects: [],
};

export class UserProfileManager {
  profile: UserProfile = { ...DEFAULT_PROFILE };
  private loaded = false;

  load(): UserProfile {
    if (this.loaded) return this.profile;
    const saved = memory.getKV<UserProfile>("user:profile");
    if (saved) this.profile = { ...DEFAULT_PROFILE, ...saved };
    this.loaded = true;
    return this.profile;
  }

  save(updates: Partial<UserProfile>): void {
    this.profile = { ...this.load(), ...updates };
    memory.saveKV("user:profile", this.profile);
  }

  setName(name: string): void {
    this.save({ name });
  }

  addImportantPerson(name: string, relationship: string, notes?: string): void {
    const people = this.load().importantPeople.filter((p) => p.name !== name);
    people.push({ name, relationship, notes });
    this.save({ importantPeople: people });
  }

  getName(): string {
    return this.load().nickname || this.load().name;
  }

  shouldUseName(): boolean {
    const p = this.load().preferences;
    if (!p.useName) return false;
    const rand = Math.random();
    switch (p.nameFrequency) {
      case "often": return rand < 0.65;
      case "sometimes": return rand < 0.3;
      case "rarely": return rand < 0.1;
      default: return rand < 0.3;
    }
  }

  generateContext(): string {
    const p = this.load();
    const lines: string[] = ["USER PROFILE:"];
    lines.push(`Name: ${p.name}${p.nickname ? ` (goes by ${p.nickname})` : ""}`);
    lines.push(`Work hours: ${p.workHoursStart}:00–${p.workHoursEnd}:00`);
    lines.push(`Style: ${p.preferences.communicationStyle}`);

    if (p.importantPeople.length > 0) {
      lines.push("Key people:");
      for (const person of p.importantPeople.slice(0, 6)) {
        lines.push(`  ${person.name} (${person.relationship})${person.notes ? ` — ${person.notes}` : ""}`);
      }
    }

    if (p.importantProjects.length > 0) {
      lines.push(`Active projects: ${p.importantProjects.join(", ")}`);
    }

    if (p.customInstructions) {
      lines.push(`Custom instructions: ${p.customInstructions}`);
    }

    return lines.join("\n");
  }
}

export const userProfile = new UserProfileManager();
