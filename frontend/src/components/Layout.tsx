import App from '../App';
import { Sidebar } from './Sidebar';

export default function Layout() {
  return (
    <div className="studio-layout">
      <a className="studio-skip" href="#studio-content">Aller au contenu</a>
      <Sidebar />
      <div className="studio-main">
        <App />
      </div>
    </div>
  );
}
