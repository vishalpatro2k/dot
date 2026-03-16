# Apple Health → Dot: iOS Shortcut Setup

This guide walks you through creating an iOS Shortcut that reads your Apple Health data each morning and sends it to Dot's server. Once set up, your morning briefs and day recaps will include sleep quality, activity, and recovery insights.

---

## Prerequisites

- Dot server running and reachable from your iPhone
- iOS 16+ (for Health data actions)

---

## Step 1: Make Your Server Reachable

Your iPhone needs to reach the Dot server. Pick one option:

### Option A — Same Wi-Fi (simplest)
Find your Mac's local IP:
```
System Settings → Wi-Fi → Details → IP Address
```
Your server URL will be: `http://192.168.x.x:3000`

### Option B — Tailscale (works anywhere)
1. Install Tailscale on Mac and iPhone
2. Use the Mac's Tailscale IP (e.g., `http://100.x.x.x:3000`)
3. Works on cellular, other Wi-Fi networks, anywhere

### Option C — ngrok (temporary, for testing)
```bash
ngrok http 3000
```
Use the `https://xxxx.ngrok.io` URL. Changes every restart.

---

## Step 2: Create the Shortcut

Open the **Shortcuts** app on your iPhone → tap **+** to create a new shortcut.

Name it: **"Dot Health Update"**

### Actions to add (in order):

---

**1. Get Health Sample — Sleep Analysis**
- Action: `Get Health Samples`
- Type: `Sleep Analysis`
- Include: `Asleep` samples
- Sort by: `Start Date` (newest first)
- Limit: `1`
- Save result to variable: `SleepSample`

---

**2. Get Health Sample — Steps**
- Action: `Get Health Samples`
- Type: `Step Count`
- Include samples from: `Yesterday` (or Last 24 Hours)
- Aggregate: `Sum`
- Save result to variable: `Steps`

---

**3. Get Health Sample — Active Energy**
- Action: `Get Health Samples`
- Type: `Active Energy Burned`
- Include samples from: `Yesterday`
- Aggregate: `Sum`
- Save result to variable: `ActiveCalories`

---

**4. Get Health Sample — Exercise Minutes**
- Action: `Get Health Samples`
- Type: `Exercise Minutes`
- Include samples from: `Yesterday`
- Aggregate: `Sum`
- Save result to variable: `ExerciseMinutes`

---

**5. Get Health Sample — Stand Hours**
- Action: `Get Health Samples`
- Type: `Apple Stand Hour`
- Include samples from: `Yesterday`
- Aggregate: `Count`
- Save result to variable: `StandHours`

---

**6. Get Health Sample — Resting Heart Rate** *(optional)*
- Action: `Get Health Samples`
- Type: `Resting Heart Rate`
- Sort by: `Start Date` (newest first)
- Limit: `1`
- Save result to variable: `RestingHR`

---

**7. Get Health Sample — Heart Rate Variability** *(optional)*
- Action: `Get Health Samples`
- Type: `Heart Rate Variability`
- Sort by: `Start Date` (newest first)
- Limit: `1`
- Save result to variable: `HRV`

---

**8. Calculate Sleep Hours**
- Action: `Calculate`
- Expression: `SleepSample.Duration / 3600`
- Save result to variable: `SleepHours`
- (Rounds to 1 decimal — use `Round` action after if needed)

---

**9. Format Bedtime**
- Action: `Format Date`
- Date: `SleepSample.Start Date`
- Format: `HH:mm`
- Save result to variable: `Bedtime`

---

**10. Format Wake Time**
- Action: `Format Date`
- Date: `SleepSample.End Date`
- Format: `HH:mm`
- Save result to variable: `WakeTime`

---

**11. Get Current Date**
- Action: `Format Date`
- Date: `Current Date`
- Format: `yyyy-MM-dd`
- Save result to variable: `Today`

---

**12. Get Dictionary** (build the JSON payload)
- Action: `Dictionary`
- Add these key-value pairs:

| Key | Value |
|-----|-------|
| `date` | `Today` (variable) |
| `sleep` | *(another dictionary — see below)* |
| `activity` | *(another dictionary — see below)* |
| `vitals` | *(another dictionary — see below, optional)* |

**Sleep dictionary:**
| Key | Value |
|-----|-------|
| `totalHours` | `SleepHours` |
| `inBedHours` | `SleepHours` *(same for now, or add In Bed sample)* |
| `efficiency` | `85` *(hardcode or calculate if you have In Bed data)* |
| `bedtime` | `Bedtime` |
| `wakeTime` | `WakeTime` |

**Activity dictionary:**
| Key | Value |
|-----|-------|
| `steps` | `Steps` |
| `activeCalories` | `ActiveCalories` |
| `exerciseMinutes` | `ExerciseMinutes` |
| `standHours` | `StandHours` |
| `moveGoalPercent` | `100` *(hardcode or pull from Move goal if available)* |

**Vitals dictionary** *(only if you added HR/HRV steps above)*:
| Key | Value |
|-----|-------|
| `restingHR` | `RestingHR` |
| `hrv` | `HRV` |

Save the whole thing to variable: `HealthPayload`

---

**13. Get Contents of URL** (POST to Dot)
- URL: `http://YOUR_SERVER_IP:3000/apple-health`
- Method: `POST`
- Headers:
  - `Content-Type`: `application/json`
- Request Body: `JSON` → select `HealthPayload`

---

**14. (Optional) Show Result**
- Action: `Show Result`
- Input: result from previous step

---

## Step 3: Set Up Automation

To run this automatically every morning:

1. Tap **Automation** tab in Shortcuts
2. Tap **+** → **Personal Automation**
3. Trigger: **Time of Day** → set to **7:00 AM**
4. Repeat: **Daily**
5. Action: **Run Shortcut** → select **"Dot Health Update"**
6. Turn OFF **"Ask Before Running"** so it runs silently

---

## Step 4: Test It

Run the shortcut manually first:
1. Open the shortcut → tap the **▶ Play** button
2. Check the result — you should see `{"success":true,...}`

Then verify on the server:
```bash
curl http://localhost:3000/apple-health/summary
```

You should see your sleep and activity data in the response.

---

## JSON Payload Reference

This is what the shortcut sends to `POST /apple-health`:

```json
{
  "date": "2026-03-17",
  "sleep": {
    "totalHours": 7.2,
    "inBedHours": 7.8,
    "efficiency": 92,
    "bedtime": "23:15",
    "wakeTime": "06:27"
  },
  "activity": {
    "steps": 8432,
    "activeCalories": 420,
    "exerciseMinutes": 35,
    "standHours": 10,
    "moveGoalPercent": 88
  },
  "vitals": {
    "restingHR": 58,
    "hrv": 45
  }
}
```

---

## Troubleshooting

**Shortcut says "Connection refused"**
- Make sure `npm run server` is running on your Mac
- Check that your iPhone and Mac are on the same network (Option A)
- Try the Tailscale option for more reliable connectivity

**Sleep hours come back as 0**
- Apple Health may not have sleep data yet — wear your Apple Watch to sleep or use a sleep tracking app
- Some iPhones only populate Sleep Analysis when using the Sleep focus mode

**Steps/calories are 0**
- Make sure the Shortcut has Health permissions — iOS will prompt the first time
- Go to Settings → Privacy → Health → Shortcuts to verify access

**Server returns 400 "Missing required fields"**
- The `date` or `sleep` key is missing from your payload — double-check the Dictionary action
