# Human Review Inbox

Human Review Inbox adds a **Request human review** action to published messages in writable Buzz channels and a **Human Review Inbox** entry in the sidebar.

1. Open a message’s action menu and choose **Request human review**.
2. Choose a named teammate with a verified writable channel role, optionally add a note, and select **Send request**.
3. The reviewer opens **Human Review Inbox**, follows **Open source**, and chooses **Approve**, **Request changes**, or **Decline**. The decision is posted as a signed reply to the review request.

The inbox checks the most recent 100 messages addressed to your current identity and shows up to 25 matching requests in channels you belong to. Select **Refresh** to check for new requests or reconcile delivery. The earliest matching receipt from the addressed reviewer is shown when several signed receipts exist. The request, note, and decision are visible to people who can read the channel. Review decisions are records for the team and have no effect on agent execution or permissions.

Built for Buzz v1.0.0 and plugin API v1. The plugin uses the active community relay and Buzz’s normal signing and outbox. It requires no extra host permissions or external service.

## Install in Buzz desktop v1.0.0

For a local checkout, open **Settings → Plugins → Manage plugins → Add**, choose **Browse** under **Add from folder**, and select this repository’s root. Review the plugin and select **Install plugin**.

Once the GitHub repository is available, paste the following URL into **Git or GitHub repository** in the same dialog, select **Find**, then review and install the plugin.

`https://github.com/cccareers/buzz-plugin-human-review-inbox`

## Build

Use Node.js 20 or later.

```sh
npm ci
npm run build
```

The build writes the self-contained `plugin.js` beside `manifest.json`. Commit the rebuilt file when you change the plugin. Buzz’s Git installer reads the committed bundle. `npm ci` also installs the pinned Buzz author types for editors.
