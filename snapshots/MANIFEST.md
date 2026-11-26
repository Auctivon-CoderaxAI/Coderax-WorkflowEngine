# Pending change set: durable events, cancellation isolation, mark-read

Base commit: `51fd4badb7faa65540542058eb612015a16abca1`
(branch `feat/workflow-engine-foundation`, remote head at the time of writing).

This branch exists to carry one change set that could not be uploaded
file-by-file in a single call. The index below is authoritative: it names every
path and its sha256 in the verified local tree. The full diff is 57,128 bytes
(1,531 lines); gzipped and base64-encoded it is 20,024 bytes.

## Status

- Local verification: `npm run verify` -> 111/111 tests, `openapi.json` matches
  the published contracts.
- Upload status: **complete**. The gzipped patch is carried by four base64 parts,
  all committed to this branch and each confirmed byte-identical to the authored
  file by comparing its git blob hash after upload:

  | part | commit | git blob | bytes |
  | --- | --- | --- | --- |
  | 0 | `3e71131` | `da0ae16bdb9fac109abe64eb4063664ba26173ea` | 6000 |
  | 1 | `534005e` | `0f0936b5ac4caae05f75c1545cfe36e8b557a12c` | 6000 |
  | 2 | `6db24ef` | `93f791d21ad7d4ec31b0c5a83c90daf6bf97b24b` | 6000 |
  | 3 | `fe3cf4b` | `78e27e2942b3b12c56dd839adc0699a2c7022658` | 2024 |

- Concatenating the four parts reproduces `pending.b64` exactly, and decoding it
  reproduces the 57,128-byte patch exactly (checked with `cmp`).

## Restore procedure

```sh
cat snapshots/durable-events.part0.b64 \
    snapshots/durable-events.part1.b64 \
    snapshots/durable-events.part2.b64 \
    snapshots/durable-events.part3.b64 | base64 -d | gunzip > /tmp/pending.patch
patch -p1 < /tmp/pending.patch
npm ci && npm run verify
```

The patch was round-trip checked: applying it to a clean checkout of the base
commit reproduced the working tree byte-for-byte, with the single expected
difference of `docs/concurrency-audit.md`, which the base commit already
contains in a newer form.

## Changed paths and checksums

```
184c84fbdf56cacf29b965fbabe04765ec0b3be9354778412191207379d370df  src/events/log.ts
8a7f85d7271a013052a45db2007313825739c184025ac450f925529daa27b664  src/events/bus.ts
c750bcab64305d66ab7f575be044fbbe86bc4e0371c7191524418dd69b76f2d1  src/persistence/mongo-events.ts
6c4875971c6bbd69b52443f2c65509887a0e4eb486bf04aa487a2cac6ef10fd5  src/execution/quarantine.ts
ab89f0315d1075d474cdc0194b29ab94a31565b04ca85350ae566f364d55bd4f  src/configuration/schema.ts
55bb2d843fdb34b426b82c7e1af5d267f348bbf60871bb4bd746dbdd76ff404c  src/bootstrap/persistence.ts
3740eb048ad8972425f3fc0b6e9dd332c637da708e3d8090bc95e3343cbf4fca  src/bootstrap/container.ts
f77ad2ef2574fc097238201a19f98db6857beb373fd1b71889639a5320b05a8a  src/bootstrap/compose.ts
08cf7886868de1551bae367f4c5e423a1b1e8631e8f37bdd01792a5e817bcf6f  src/orchestration/service.ts
b8f017d31d6de9b748d52f35357b15fae539ac54160218c19c856e85a92c8437  src/api/router.ts
6e8dd272924d38b7d1aac7b16998dd0de922e42522c4a69f15bd8c57092f7eaf  src/api/server.ts
414838de9df067a3c9f5e350829f6754c36c0fc59e8eec04b546bcc2639bc93b  src/api/routes.ts
2a412ffaf7c2443c644cd47e075ef82c7c865ec03fe8f4755c8970584b7e8129  src/persistence/mongo.ts
bda2c6693b3875dcbbec61043412bb692810b5769c7de49f1ca5d360fafea6bd  packages/contracts/src/permissions.ts
bfdbda586520a373ba6113b2a22fad0cc69b04a9240dc08e496c07342d4b647d  packages/contracts/src/routes.ts
66a2a2e6cbba417e0bfd67b42d03b92e7131e828ed7176dfdbcf1b7531ce9b2e  packages/sdk/src/index.ts
3ac337fa857aa40d43829b0214232b699ea666634709f71f31389770bca89db2  openapi.json
4e635e3c96cd59473b1bb56fe4ffe0ba6b9200fb4fbc47e488b8473ce126d4c5  tests/unit/events-durable.test.ts
6a460e6919f9d50b341ebc8b794eae78f16f80a9bc15bb18fcde9c3250ee0218  tests/fakes/mongo.ts
01fa4e6e539e49edced0417db95490b528ba7d3b67d252c9f551194bfdde6ce8  docs/parity-matrix.md
```

`openapi.json` and `dist/` are derived; the specification regenerates from
`packages/contracts` with `npm run openapi:write`. The remaining paths are
hand-written.

## Part checksums

```
fb4a73870bc8c5669e6fdb9c516221cbfd6f9d05087f6fd91b0bf648c48c370b  part0 (6000 bytes)
a2e1b93ea61f7b750e1594aa78edadbf644fa3a72811a23fd9fd2b4dfb628a06  part1 (6000 bytes)
c5307904c3c7eb9fd51b517e5c457e366c35f91617f572640214ae43816fba2a  part2 (6000 bytes)
fc820012456874b2c1aeccaf445f409d67937b54c3c4b68cdd926079b4a896db  part3 (2024 bytes)
```

This file and the snapshot parts are temporary scaffolding. Delete them in the
commit that lands the real files.
