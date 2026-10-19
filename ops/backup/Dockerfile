# Daily logical backup of production (see README.md). pg_dump must match the server's major version.
FROM postgres:18-alpine
RUN apk add --no-cache rclone ca-certificates su-exec
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
CMD ["/usr/local/bin/backup.sh"]
