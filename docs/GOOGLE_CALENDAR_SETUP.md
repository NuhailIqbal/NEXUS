# Google Calendar setup

NEXUS agents can check free times and book meetings in a customer's Google Calendar
(tools **Check Availability** and **Book Calendar Slot**). Each NEXUS account connects its own
calendar from **Integrations → Calendar**. For that button to work, the *server* needs a Google
OAuth client. You create it once.

## 1. Create the OAuth client (Google Cloud Console)

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**
   - User type **External**. Fill in app name, support email, developer email.
   - **Scopes** → add exactly these (they are the narrowest that work):
     - `.../auth/calendar.events` (create the booking)
     - `.../auth/calendar.freebusy` (read *busy times only* — never event titles or details)
     - `openid`, `email` (show which Google account is connected)
   - While the app is in **Testing**, add each person who will connect as a **Test user**
     (up to 100). Everyone else sees "access blocked".
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type **Web application**.
   - **Authorized redirect URIs** — add every place the backend runs:
     - production: `https://<your-api-domain>/calendar/google/callback`
     - local dev: `http://localhost:8000/calendar/google/callback`
5. Copy the **Client ID** and **Client secret**.

## 2. Configure the server

Add to the backend environment (`.env`):

```
GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="..."
# optional — defaults to <PUBLIC_API_URL>/calendar/google/callback (http://localhost:8000/... if unset)
GOOGLE_REDIRECT_URI=""
PUBLIC_APP_URL="https://<your-app-domain>"   # where Google sends people back to after connecting
PUBLIC_API_URL="https://<your-api-domain>"   # already required for agent tools
```

The redirect URI the server sends must match one from step 1.4 **exactly** (scheme, host, port, path),
or Google shows `redirect_uri_mismatch`. Restart the backend afterwards — it creates the new
tables (`calendar_connections`, `calendar_bookings`) on start.

## 3. Use it

1. As the account **owner**: Integrations → Calendar → **Connect Google Calendar**, approve access.
2. Click **Settings** to set working days/hours, timezone, meeting length, buffer, minimum notice
   and how far ahead people may book. (Timezone defaults to your browser's.)
3. Edit an agent → **Complete Setup → Agent tools** → tick **Check Availability** and
   **Book Calendar Slot**. Save.
4. Tell the agent in its prompt when to offer meetings.

## Going public

Sensitive scopes like Calendar need **Google's app verification** before people outside your test
list can connect (Google Cloud Console → OAuth consent screen → *Publish app*). Until then, only
listed test users can connect, and Google may expire their grants after 7 days (they then see
**"Needs to be reconnected"** on the Integrations page and just reconnect).

## Behaviour worth knowing

- Only the account **owner** can connect, change settings, or disconnect. Team members see status.
- One calendar per account (the owner's primary calendar).
- The agent re-checks the slot at booking time, so two callers can't take the same time, and a
  retried tool call never books twice.
- If Google stops accepting the connection, the agent tells the caller it can't book and the
  Integrations page shows **Needs to be reconnected**.
- Disconnecting revokes NEXUS's access at Google and deletes the stored token. Meetings already
  booked stay in the calendar.
- The refresh token is stored encrypted; it is never sent to the browser.
