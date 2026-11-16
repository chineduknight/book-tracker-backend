# Backup and restore

Status: **tooling implemented and rehearsed on disposable local databases only.** No backup has
been taken from, or restored to, any shared database. Targets, tiers and storage need the owner's
approval ([deployment-decision.md](deployment-decision.md)).

## The JSON export is not a backup

`GET /api/v1/export/archive` lets **one reader** download their own data. It is not a disaster
recovery backup: it omits internal state (sessions, refresh tokens, password hashes,
`hasPhysicalCopyHistory`, revision counters), covers one account at a time, and V1 has no import
endpoint. Recovering the service needs a full MongoDB backup of the application database.

## Targets (proposed, owner to confirm)

| Target                        | Proposal                                                                                                                                              | Status                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| RPO (maximum data loss)       | **≤ 24 hours**: one verified backup per day                                                                                                           | Awaiting owner approval |
| RTO (time to restore service) | Measured, not promised. Local drill: 21,500 documents restored and verified in 2.8 s; Atlas over the internet will be slower; staging must measure it | Measure on staging      |
| Retention                     | 7 daily + 4 weekly backups, then delete                                                                                                               | Awaiting owner approval |
| Rehearsal                     | Before launch, then monthly, and after any change to models or indexes                                                                                | Awaiting owner approval |

## Options

| Option                                         | Cost                         | Notes                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator `mongodump`** (`npm run db:backup`) | $0 vendor fees; owner's time | Works on every tier including M0. Required until a native backup has passed a rehearsal. Not point-in-time: M0/Flex do not support `--oplog`, so writes during the dump may be partially included; run it in a quiet hour. |
| Atlas Free backup (private preview)            | $0.10/day, max $3/month      | May not be offered to the project; one daily snapshot, last four kept; needs a payment method; not assumed.                                                                                                                |
| Atlas Flex                                     | Included in $8–$30/month     | Daily snapshots, last eight kept, no point-in-time restore.                                                                                                                                                                |
| Atlas M10+ cloud backup                        | Billed by snapshot storage   | Point-in-time recovery available; beyond the current budget.                                                                                                                                                               |

Whatever is chosen, a backup counts only after a restore rehearsal from it has passed.

## Taking a backup (`npm run db:backup`)

Run from an operator machine with a checkout of the deployed commit, `npm ci`, the MongoDB
Database Tools (`mongodump`, `mongorestore`; 100.16.1 is what CI uses) and the operator's IP
temporarily in the Atlas access list.

```bash
export MONGODB_URI='<read-only backup user URI naming the database>'   # typed, not saved in a file
npm run db:backup -- --out-dir="$HOME/book-tracker-backups"
unset MONGODB_URI
```

What it does and refuses:

- Reads only. Connects with automatic index and collection creation off.
- Writes `<database>-<UTC time>.archive.gz` (mongodump archive, gzip) and
  `<archive>.manifest.json`: SHA-256, size, and per-collection document counts and index names.
  No document contents are printed.
- Refuses an output directory inside the repository (backups must never be committed) or one that
  other local users can read (`chmod 700`). Files are created `0600` and never overwritten.
- Passes the URI to `mongodump` in a private temporary config file (`0600`, deleted afterwards),
  not on the command line where other local users could see it. The tool's own output is withheld
  because it can include host and user names; failures report only the exit code.
- On failure it deletes the partial archive.

## Storing backups

- **Encrypt before the archive leaves the operator machine**, for example with
  [`age`](https://age-encryption.org) to a public key whose private key is kept offline:
  `age -r <public key> -o archive.gz.age archive.gz && shred -u archive.gz` (keep the manifest
  alongside; it holds no data). Record where the private key is; losing it loses every backup.
- Keep encrypted copies in two places the owner controls (for example an encrypted external disk
  and a private cloud drive with two-factor sign-in).
- **Never** store backups in Git, the API container, CI logs or artifacts, a public bucket, chat,
  or email.
- Apply the retention above; delete expired archives from every location.
- Watch the backup age: if the newest verified backup is older than 24 h, that is an incident
  ([monitoring-and-budget.md](monitoring-and-budget.md)).

## Restore rehearsal (`npm run db:restore-rehearsal`)

Proves a backup can be restored and is consistent, without touching any shared database.

```bash
# decrypt to the private directory first if the archive is encrypted
RESTORE_REHEARSAL_URI=mongodb://127.0.0.1:27017/book-tracker-restore-rehearsal \
  npm run db:restore-rehearsal -- --archive="$HOME/book-tracker-backups/<file>.archive.gz"
```

- The target must be a local MongoDB (`127.0.0.1`, `localhost` or `[::1]`), named exactly
  `book-tracker-restore-rehearsal`, and **empty**; anything else is refused before connecting
  (the same guard as the integration tests). It never uses `--drop`.
- Checks the archive's SHA-256 against its manifest before restoring.
- Restores with `mongorestore --nsFrom/--nsTo` into the rehearsal database and reports the time
  taken (record it as the restore component of RTO).
- Verifies, read-only: every collection's document count and index names equal the manifest;
  every required index is present and not conflicting ([index-operations.md](index-operations.md));
  up to 50 documents per collection pass the current schemas (failing field names are reported,
  never values).
- Leaves the database for review; drop it afterwards
  (`mongosh 'mongodb://127.0.0.1:27017/book-tracker-restore-rehearsal' --eval 'db.dropDatabase()'`).

Record each rehearsal: date, archive name, restore seconds, result, operator.

Automated evidence (CI, MongoDB 8.0, synthetic data): `test/integration/backup-restore.test.ts`
backs up, restores, checks file permissions and cleanup, proves the restored
`owner_copy_single_active` index still refuses a second active loan, and covers the refusals
(non-empty, remote or misnamed target, tampered archive, output inside the repository or readable
by others, unreachable source).

## Real recovery (manual, owner-approved)

There is deliberately **no command that restores into a shared database**. A recovery restores
into a **new** database and switches the API to it, so the damaged database stays available for
investigation and nothing is overwritten.

1. **Stop writes:** suspend the API service (or scale to zero). Note the time; any write after the
   last backup and before this point is lost unless recoverable from the damaged database.
2. Choose the newest verified backup and verify its checksum (`shasum -a 256`, compare with the
   manifest).
3. Rehearse it locally first (above) if time allows.
4. Restore into a new database on the production cluster, never with `--drop`:
   `mongorestore --config=<private file holding the uri> --archive=<file> --gzip --nsInclude='<old>.*' --nsFrom='<old>.*' --nsTo='<new>.*' --stopOnError`
   where `<new>` is, for example, `book-tracker-restored-20261115`. Keep the config file `0600`
   and delete it afterwards.
5. `MONGODB_URI=<uri naming the new database> npm run db:indexes` must exit 0 (mongodump archives
   include index definitions; build any missing ones with `--apply` if not).
6. Compare document counts with the manifest; spot-check the owner's own records.
7. Grant the API user `readWrite` on the new database, update `MONGODB_URI` to name it, redeploy,
   wait for `/api/v1/ready` 200, run the smoke checklist
   ([deployment-runbook.md](deployment-runbook.md#6-non-destructive-smoke-checklist-staging-or-production)).
8. Sessions created after the backup no longer exist, so affected readers sign in again. Revoked
   sessions or consumed refresh tokens from after the backup are also gone; if the incident
   involved stolen credentials, follow the session-revocation procedure after restoring.
9. Keep the old database read-only until the incident is closed; drop it only with the owner's
   written approval.

Code rollback is separate: redeploying an older commit does not revert data, and restoring data
does not require an older commit unless the schema changed incompatibly
([deployment-runbook.md](deployment-runbook.md#8-rollback)).

## Responsibilities

| Task                                 | Owner                       |
| ------------------------------------ | --------------------------- |
| Daily backup (until automated)       | Owner / designated operator |
| Encryption key custody               | Owner                       |
| Monthly restore rehearsal and record | Owner / designated operator |
| Decision to restore production       | Owner                       |
| Retention clean-up                   | Owner / designated operator |
