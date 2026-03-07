import { getJavaScriptRuntimeClient, getTypeScriptRuntimeClient } from './javascript-runtime-client';
import { getPythonRuntimeClient } from './python-runtime-client';
import type { Language, RuntimeClient } from '../../harness-core/src/runtime-types';
export {
  getLanguageRuntimeProfile,
  getSupportedLanguageProfiles,
  isLanguageSupported,
  LANGUAGE_RUNTIME_PROFILES,
  SUPPORTED_LANGUAGES,
} from './runtime-profiles';

export function getRuntimeClient(language: Language): RuntimeClient {
  if (language === 'python') {
    return getPythonRuntimeClient();
  }
  if (language === 'javascript') {
    return getJavaScriptRuntimeClient();
  }
  if (language === 'typescript') {
    return getTypeScriptRuntimeClient();
  }

  throw new Error(`Runtime for language \"${language}\" is not implemented yet.`);
}
