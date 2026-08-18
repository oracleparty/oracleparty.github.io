# Turning on "Continue with Google"

The code is done and deployed. Google sign-in will not work until the two
services below are told about each other — that part can only be done by
someone signed in to the accounts, so it needs you.

It takes about ten minutes. **Nothing breaks while it is switched off**: the
button appears, and if it is pressed before setup is finished it says
"Couldn't reach Google — try email instead". Email sign-up keeps working
throughout.

---

## Part 1 — Google (about 6 minutes)

1. Go to **https://console.cloud.google.com/** and sign in.
2. Top-left, click the project dropdown → **New Project**. Call it
   `Oracle Party`. Create it, then make sure it is the selected project.
3. In the search bar type **OAuth consent screen** and open it.
   - User type: **External**. Create.
   - App name: `Oracle Party`
   - User support email: your email
   - Developer contact: your email
   - Save and continue through the remaining steps. You do **not** need to add
     scopes or test users.
   - On the summary page, click **Publish app** if it offers to. Without this,
     only accounts you list by hand can sign in.
4. Search for **Credentials** and open it.
   - **Create credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Name: `Oracle Party Web`
   - Under **Authorised JavaScript origins**, add:
     ```
     https://oracleparty.github.io
     ```
   - Under **Authorised redirect URIs**, add exactly this:
     ```
     https://zzpqymehapwbjupphxec.supabase.co/auth/v1/callback
     ```
     That is Supabase's address, not yours. Google sends the player to
     Supabase, and Supabase sends them back to the game.
   - Create. A box appears with a **Client ID** and a **Client secret**.
     Keep it open, or copy both somewhere for a moment.

## Part 2 — Supabase (about 3 minutes)

5. Go to **https://supabase.com/dashboard**, open the Oracle Party project.
6. Left sidebar: **Authentication** → **Providers** (called "Sign In / Up" in
   some versions) → find **Google** in the list.
7. Turn it **on**, paste in the **Client ID** and **Client secret** from step
   4, and save.
8. Left sidebar: **Authentication** → **URL Configuration**.
   - **Site URL**: `https://oracleparty.github.io`
   - **Redirect URLs**: add
     ```
     https://oracleparty.github.io/**
     ```
     The `/**` matters — it lets a player sign in from any page and come back
     to the one they were on, rather than always landing on the home screen.

## Part 3 — check it

9. Open the game, tap to create an account, and press **Continue with Google**.
   You should go to Google, pick your account, and come straight back signed in.

If it fails, the message on screen usually says which side is unhappy:

| What you see | What it means |
|---|---|
| `redirect_uri_mismatch` | Step 4's redirect URI is wrong. It must be the **supabase.co** callback, character for character. |
| `Access blocked: this app is not verified` | The consent screen in step 3 was not published, or your account is not on the test-user list. |
| Comes back but still signed out | Step 8's Redirect URLs are missing the `/**`. |
| "Couldn't reach Google" | Google is not enabled in step 7. |

---

## Worth knowing

**This does not make the database safer.** Guests still play without accounts,
so the app's key must still be accepted from anyone holding it. Sign-in makes
joining easier and ties stats and feedback to a real person; locking the
database down is a separate job that needs scoring moved to the server.

**Nobody is forced to sign in.** Guests keep full access to playing, hosting,
chat and question feedback. Accounts add friends, stats, titles and the
leaderboard, exactly as before.
