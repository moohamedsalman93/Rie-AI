import { WEB_SEARCH_PROVIDERS } from '../components/settings/constants';

export function getWebSearchProvider(settings) {
  const id = (settings?.web_search_provider || 'tavily').toLowerCase();
  return WEB_SEARCH_PROVIDERS[id] ? id : 'tavily';
}

export function isWebSearchConfigured(settings) {
  const providerId = getWebSearchProvider(settings);
  const provider = WEB_SEARCH_PROVIDERS[providerId];
  if (!provider?.requiresKey) {
    return true;
  }
  const field = provider.keyField;
  const value = settings?.[field];
  return Boolean(value && String(value).trim());
}

export function webSearchMissingKeyMessage(settings) {
  const providerId = getWebSearchProvider(settings);
  const provider = WEB_SEARCH_PROVIDERS[providerId];
  if (!provider?.requiresKey) {
    return null;
  }
  return `Add a ${provider.label} API key in Memory settings to enable Internet Search.`;
}
