# Bring your own Meta API key

Bring your own Meta API key to run plans in SightWork. This takes about 10 minutes and you don't need to know how to code. The same guide is in the app at `/help/own-key` (linked from Settings) when own-key mode is on.

The key stays in your browser. If you'd rather not deal with a key, paid SightWork plans will run on SightWork's own access instead.

SightWork uses the **Meta Model API** (the Muse and SAM models at `https://api.meta.ai/v1`). One key covers every model SightWork uses.

## 1. Get a key from Meta
1. Go to [dev.meta.ai](https://dev.meta.ai) and log in to the Model API dashboard. If Meta asks you to set up an account or add a way to pay, follow its steps.
2. Open the **API keys** tab and click **Create API key**. Give it a name you'll recognize, like "SightWork", then click **Create**.
3. Copy the key right away. Meta shows it only once. A real key starts with `LLM_`, followed by numbers, an underscore and a long string of letters and numbers.

Meta's own steps: [Authentication (get an API key)](https://dev.meta.ai/docs/authentication).

## 2. Add it to SightWork
1. Open **Settings** (`/settings`) on the phone or computer you'll use to make plans.
2. Under **Bring your own Meta API key**, paste the key into the **Meta API key** box and press **Save key**.

Paste only the key. If you copied extra words or quotes, SightWork tidies them, and it tells you in plain words if something still looks wrong.

## 3. Check it works
- After saving you'll see **Key saved in this browser.** and a **Saved key** showing only the first and last 4 characters.
- Make a plan in the app. A short test walkthrough of one small room is enough. When it finishes, your key works.
- If you see **"Meta didn't accept your API key"**, the key was mistyped, deleted, or your Meta account needs attention. Make a new key and replace it (below).
- You can see your use in Meta's dashboard. Meta's [quickstart](https://dev.meta.ai/docs/quickstart) lists common key errors.

## 4. Remove or replace it
- In Settings, press **Forget key**. The key is removed from this browser right away.
- To use a different key, forget the old one, then paste the new one and press **Save key**.
- To shut a key off everywhere, delete it in Meta's dashboard ([Revoke an API key](https://dev.meta.ai/docs/authentication#revoke-an-api-key)).

## 5. Keep it safe
- Your key stays in this browser on this device. It is never sent to SightWork's servers.
- Your browser sends it straight to Meta, and only while it makes a plan.
- Treat it like a password. Don't text, email or post it, and don't share it with anyone.
- On a shared or office computer, press **Forget key** when you're done.
- Make a separate key just for SightWork, so you can delete it without breaking anything else.
- If you think someone else has it, delete it in Meta's dashboard and make a new one.

## Tips for a good plan
**Filming the walkthrough**
- Turn the lights on and walk slowly.
- Hold the phone steady at chest height.
- Pause a second on each problem, close enough to see it.
- Pick the room size first so the recorder tells you when to wrap up ([Video length by room size](../README.md#video-length-by-room-size)).

**Describing the room**
- Talk while you film: say what you see and what you want fixed.
- Name the room and what it's used for.
- Say what matters most, any deadline and a rough budget.

**Churches, schools and facilities**
- Film one space per plan: a stage, a classroom, a hallway.
- Point out safety issues out loud, like loose cords or broken steps.
- Mention who will do the work: volunteers or a contractor.

**Homeowners**
- Film the room as it is now, even if it's empty.
- Describe the finished room you want: style, colors, what stays.
- Say if you plan to do it yourself or hire help.

