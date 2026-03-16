/**
 * Onboarding
 *
 * First-run setup: learns user's name and sets initial preferences.
 */

import { memory } from "../memory/store.js";
import { userProfile } from "./user-profile.js";

export function isOnboardingComplete(): boolean {
  return !!memory.getKV<boolean>("onboarding:completed");
}

export function completeOnboarding(name: string, preferences?: Partial<typeof userProfile.profile.preferences>): void {
  userProfile.setName(name);
  if (preferences) userProfile.save({ preferences: { ...userProfile.load().preferences, ...preferences } });
  memory.saveKV("onboarding:completed", true);
}

export function generateWelcomeMessage(name: string): string {
  return `Hey ${name}!

I'm Dot — your personal companion. I'll help you manage your day, protect your focus, and stay on top of things.

Here's what I can help with:
Morning briefs and day recaps
Focus sessions with Do Not Disturb
Smart scheduling and meeting prep
Task tracking and predictive nudges

I'll learn your patterns over time and adapt to how you work.

What would you like to start with?`;
}
