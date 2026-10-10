# GHCR images and Arcane

The [images workflow](https://github.com/nabbl/catbots/actions/workflows/images.yml)
tests the engine and builds the engine and dashboard before publishing all three
images for `linux/amd64` and `linux/arm64`:

- `ghcr.io/nabbl/catfolio-engine`
- `ghcr.io/nabbl/catfolio-web`
- `ghcr.io/nabbl/catfolio-backup`

Pushes to `main` publish `edge` and the full source commit SHA. Tags beginning with
`v` publish the version without `v`, `latest`, and the full source commit SHA.
The workflow can also be run manually on `main` or a version tag. Pull requests
run validation only. Publishing uses the repository's `GITHUB_TOKEN` with
`packages: write`; no additional publishing secret is needed. Each image has
source/revision labels, and job summaries record its published digest.

The deployable project lives in
[`nabbl/gitops-arcane/catfolio-docktail`](https://github.com/nabbl/gitops-arcane/tree/main/catfolio-docktail).
In Arcane create a Pull Git Sync from that repository's `main` branch with Compose
path `catfolio-docktail/compose.yaml`. Set private configuration in Arcane's
Environment editor using that folder's `.env.example` as the starting point.
The project uses prebuilt images, DockTail HTTPS, and persistent named volumes;
it forces paper mode. Local `docker-compose.yml` continues to build locally.

Select either LM Studio with a host reachable from the Arcane server and a loaded
decision model, or explicitly select Jev and supply its provider key. If using
LM Studio on another machine, `host.docker.internal` is not that machine: set
`LM_STUDIO_HOST_ORIGIN` to its reachable address. Consult the main README for
provider validation and the separate coach approval token.

New GHCR packages are private by default. Configure `ghcr.io` in Arcane's container
registries with username `nabbl` and a GitHub classic PAT with `read:packages`, or
change all three packages to public in their GitHub package settings. Git repository
authentication and registry authentication are separate. Never commit registry or
provider credentials.

For controlled upgrades, update all three image references in the GitOps Compose
file to the successful build's full source commit SHA (or pin each image by its
digest), then sync and redeploy through Arcane.
The optional `CATFOLIO_IMAGE_TAG=edge` override follows main when images are pulled;
a mutable tag changing alone does not change the Git Compose file or trigger Git
Sync. Keep the database volume through upgrades and do not run two engines against
the same database.

References: [Arcane Git Sync](https://getarcane.app/docs/docker/git-sync) and
[GHCR authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
