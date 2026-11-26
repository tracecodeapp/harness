const candidateWitnessLanguages = new Set(['java', 'csharp', 'python']);

export function candidateWitnessRequired(language) {
  return candidateWitnessLanguages.has(language);
}

export function shouldValidateCandidateWitness(version, groupLanguage, testedLanguage) {
  return version.startsWith('candidate-') &&
    groupLanguage === testedLanguage &&
    candidateWitnessRequired(groupLanguage);
}
