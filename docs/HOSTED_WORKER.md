# Hosted worker contract

The hosted adapter is implemented. A real hosted deployment has not been executed.

The service calls a private HTTPS endpoint with a bearer credential.
The endpoint supports capabilities, proof, compilation, and execution.
Every proof and executable response includes source and artifact hashes.

The supplied worker accepts only generated calibration catalog source.
It cannot execute arbitrary repository scripts.
It executes only binaries that the same worker previously built.

Place the worker inside an ephemeral Linux x86-64 virtual machine.
Use an unprivileged account, private networking, bounded memory, and a read-only application image.
Give the worker no model credentials, cloud credentials, customer keys, or unrelated storage access.
Terminate HTTPS at the private ingress.

Build the image from the project directory:

```sh
docker build --platform linux/amd64 -f deploy/Dockerfile.worker -t mirage-worker:demo .
```

Record the immutable image identity before execution:

```sh
export MIRAGE_WORKER_IMAGE_DIGEST="$(docker image inspect mirage-worker:demo --format '{{.Id}}')"
```

The service rejects hosted runs without this declared image identity.
The operator remains responsible for checking the deployed image against that identity.

Run it only inside the intended isolation boundary:

```sh
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --cpus 2 --pids-limit 64 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /app/.data:rw,nosuid,size=512m,uid=1000,gid=1000 \
  --env MIRAGE_WORKER_TOKEN --env MIRAGE_WORKER_IMAGE_DIGEST -p 127.0.0.1:4190:4190 mirage-worker:demo
```

The container alone does not establish the hosted isolation claim.
The operator must validate the enclosing virtual machine and private ingress.
Set `MIRAGE_WORKER_URL` and `MIRAGE_WORKER_TOKEN` on the service after that validation.

The compiler major version and CBMC artifact are pinned in the Dockerfile.
The manifest records the full compiler version and exact binary hash.
The image has not been built here because Docker has no running daemon.

General repositories require another reviewed adapter.
That adapter must freeze the commit, download bounded files, reject links and path escapes, and isolate all build instructions.
The GitHub connector now stores verified file content, immutable source identities, and dependency manifest identities.
It never executes repository instructions.
