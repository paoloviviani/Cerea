# The backup sidecar's image: restic, rclone, the database clients and a cron
# runner in one small Alpine image. No stock image carries all of them, and
# the dumps must be taken over the stack's network (no Docker socket), so the
# clients have to be in the same container as restic.
#
# restic and rclone are the official binaries, copied from their own pinned
# images: the repository format and the rclone protocol are the parts you
# least want to drift. The rest comes from the pinned Alpine release:
# postgresql18-client (pg_dumpall's major version must be >= the server's,
# pgvector/pgvector:pg18), mongodb-tools (100.x; speaks to mongo:4.4),
# supercronic (a cron that logs to stdout and runs as a normal process),
# sqlite (a consistent copy of Authelia's database) and GNU tar.
#
# Built by compose, from the override (see the README): `docker compose build
# backup`, or `docker compose up -d --build backup` after an upgrade.
FROM restic/restic:0.18.1 AS restic
FROM rclone/rclone:1.73.0 AS rclone

FROM alpine:3.23.6
RUN apk add --no-cache ca-certificates tzdata tar sqlite openssh-client-default \
      postgresql18-client mongodb-tools supercronic \
 && rm /usr/bin/mongoexport /usr/bin/mongofiles /usr/bin/mongoimport /usr/bin/mongostat /usr/bin/mongotop
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY cerea-backup /usr/local/bin/cerea-backup
RUN chmod 0755 /usr/local/bin/cerea-backup \
 && ln -s cerea-backup /usr/local/bin/backup-now \
 && ln -s cerea-backup /usr/local/bin/backup-health
LABEL org.opencontainers.image.title="cerea-backup" \
      org.opencontainers.image.description="restic backup sidecar for a Cerea deploy kit stack"
ENV RESTIC_CACHE_DIR=/state/cache
ENTRYPOINT ["cerea-backup"]
CMD ["daemon"]
