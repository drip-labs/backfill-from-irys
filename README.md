Given a tx id that is failing on arweave: ZAiy2oDJP1PcjDftWzdtmSAD91vZoz0WJZ4FdqMS6WU

Steps:

    node src/check-irys-bundle.cjs ZAiy2oDJP1PcjDftWzdtmSAD91vZoz0WJZ4FdqMS6WU

If this produces a bundle id, use it:

    node src/fetch-arweave-chunks.cjs B8_2kqgHt1pDzel5VWTpKAFlPPzecrPnv9CPGCgMC0k

    node src/reupload.cjs B8_2kqgHt1pDzel5VWTpKAFlPPzecrPnv9CPGCgMC0k

If that all works, poll to see if the file is fixed on arweave:

  watch -n 10 curl -L --silent -I -X GET "https://arweave.net/ZAiy2oDJP1PcjDftWzdtmSAD91vZoz0WJZ4FdqMS6WU"
