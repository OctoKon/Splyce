import { mount } from 'svelte';
import '@splyce/design-tokens/tokens.css';
import './styles.css';
import App from './App.svelte';

if (import.meta.env.VITE_E2E) {
  await import('@wdio/tauri-plugin');
}

const target = document.getElementById('root');
if (!target) throw new Error('Missing #root');

export default mount(App, { target });
