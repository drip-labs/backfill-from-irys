Given a tx id that is failing on arweave: ZAiy2oDJP1PcjDftWzdtmSAD91vZoz0WJZ4FdqMS6WU

Recommended: Use the all-in-one script:

    node src/arweave-fix-all.mjs ZAiy2oDJP1PcjDftWzdtmSAD91vZoz0WJZ4FdqMS6WU

This will:
  1. Check if the tx is already on Arweave (bundled)
  2. If not, check Irys for a bundle id
  3. If found, fetch the chunks
  4. Reupload them
  5. Poll Arweave until the tx is available

---

Manual steps (if you want to run them individually):

    node src/check-irys-bundle.mjs ZAiy2oDJP1PcjDftWzdtmSAD91vZoz0WJZ4FdqMS6WU

If this produces a bundle id, use it:

    node src/fetch-arweave-chunks.mjs B8_2kqgHt1pDzel5VWTpKAFlPPzecrPnv9CPGCgMC0k

    node src/reupload.mjs B8_2kqgHt1pDzel5VWTpKAFlPPzecrPnv9CPGCgMC0k

If that all works, poll to see if the file is fixed on arweave:

  watch -n 10 curl -L --silent -I -X GET "https://arweave.net/ZAiy2oDJP1PcjDftWzdtmSAD91vZoz0WJZ4FdqMS6WU"
