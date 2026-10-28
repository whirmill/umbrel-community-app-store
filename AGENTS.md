# Store contents

This public repository is the Whirmill Umbrel community app store. It holds only
what Umbrel and the node need to install and run an app: manifests, compose files,
icons, hooks and host installers. Application source, development documentation
and operating notes live in the apps' private repositories.

| App | Source |
|---|---|
| `whirmill-satssurge-autopilot` | `whirmill/satssurge-autopilot`: development rules, Pi documentation, status page |
| `whirmill-cloudflare-ddns` | `whirmill/cloudflare-ddns` |
| `whirmill-zapbot` | `whirmill/zapbot-exs` (image). Packaging scripts, the pre-start hook and package tests stay here |
| `whirmill-limpidog` | `whirmill/limpidog-crm` |
| `whirmill-byparr`, `whirmill-tdarr`, `whirmill-simplex-*` | third-party images; manifest and compose only |

- A release tags the app repository, which builds and publishes the image to GHCR.
  The store change then pins the version in `umbrel-app.yml` and the image digest in
  `docker-compose.yml`. Images stay public; their source repositories are private.
- SatsSurge host installers (`whirmill-satssurge-autopilot/scripts/`) stay here because
  the node runs them from its copy of the store. Their tests:
  `python3 -m unittest discover -s whirmill-satssurge-autopilot/scripts/tests`.
- Do not add application source, development notes, credentials or node data here.

Preserve unrelated edits and original financial receipts. Publication,
installation, and real financial qualification are separate from local code
implementation and require the corresponding user authority and workflow.
