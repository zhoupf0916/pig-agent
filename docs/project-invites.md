# Project invites (local host)

Milestone J3. Completes the Milestone A placeholder: invite by **display name**, persist a **pending invite**, and **accept / decline / redeem** on a single Pig instance.

This is not SSO, email delivery, or multi-tenant ACLs. Default runtime stays **pig**. Handoff inbox items (Milestone F) are unchanged.

## Model

Invites live on `data/projects/<id>/project.json` as `invites[]`. Each row has its own redeemable `token`. Inbox items (`data/inbox.json`, `kind=invite`) carry enough fields to open the project and show inviter / note.

```json
{
  "id": "pinv_…",
  "token": "inv_…",
  "displayName": "小陈",
  "note": "帮忙看 brief",
  "invitedByUserId": "user_local",
  "invitedByName": "本机用户",
  "status": "pending",
  "createdAt": "…"
}
```

`status` is `pending` | `accepted` | `declined` | `revoked`. Accepting adds a `role=member` row to `members` (same display name is reused). Accepting twice is idempotent. The project owner stays; `DELETE` on an owner returns 400.

## API

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/projects/:id/members` | Create pending invite + unread inbox item. Body `{ displayName?, note? }` |
| GET | `/api/projects/:id/members` | `{ members, invites, pendingInvites, inviteToken }` |
| POST | `/api/projects/:id/invites/redeem` | Accept by token (`{ token }`). Idempotent if already accepted |
| DELETE | `/api/projects/:id/invites/:inviteId` | Revoke a pending invite |
| DELETE | `/api/projects/:id/members/:memberId` | Remove a non-owner member |
| POST | `/api/inbox/:id/accept` | Accept from inbox (adds member, marks invite + item) |
| POST | `/api/inbox/:id/decline` | Decline / ignore (terminal, no member) |
| POST | `/api/inbox/:id/read` | Mark read (unchanged) |

201 create body includes `{ inviteToken, invite, members, invites, inboxItem }`. Inbox `kind=invite` fields: `projectId`, `projectName`, `inviterName`, `inviteeName`, `inviteNote`, `inviteId`, `inviteToken`, `inviteStatus`.

Redeem / accept of an unknown token is 404 (`邀请令牌无效或已失效`). Decline or redeem of a revoked/declined invite is 400 (`邀请已失效（已拒绝或已撤销）`). Accepting a `kind=handoff` inbox item is 400.

## Web

- Project page: invite form (display name + optional note), copyable token, paste-to-redeem, owner + members + pending list, **撤销** on pending, no owner remove.
- Inbox: invite rows show project name + inviter / note; **接受** joins and opens the project; **忽略** marks the invite terminal without navigating away; row click still opens the project and marks read; Esc / outside click closes the menu. Invalid or expired redeem tokens show a readable error and do not add a member.
- Handoff rows keep **打开会话**.

## Out of scope

Real OAuth / SSO, email, Desk Remote, Firecracker, marketplace, changing cloud `env.json` / `environment.json` behavior, provider keys in project JSON.
