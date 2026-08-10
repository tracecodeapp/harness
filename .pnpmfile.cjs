const candidatePackages = {
  "@tracecode/tracecc": process.env.TRACECODE_TRACECC_CANDIDATE_PACKAGE,
  "@tracecode/tracejvm": process.env.TRACECODE_TRACEJVM_CANDIDATE_PACKAGE,
};

module.exports = {
  hooks: {
    readPackage(manifest) {
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
        if (!manifest[field]) continue;
        for (const [name, source] of Object.entries(candidatePackages)) {
          if (source && manifest[field][name]) manifest[field][name] = source;
        }
      }
      return manifest;
    },
  },
};
