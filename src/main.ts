import './ui/styles.css';
import { App } from './editor/app';

const app = new App(document.getElementById('app')!);
(window as any).studio = app; // handy for debugging from Safari Web Inspector
