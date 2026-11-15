import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription } from './ui';
import { SimulationDashboard } from './simulation/SimulationDashboard';

export default function MainView() {
  const navigate = useNavigate();

  const quickActions = [
    {
      title: 'Journaux',
      description: 'Journaux et erreurs du serveur',
      icon: '/icons/code.svg',
      path: '/logs',
      color: 'border-orange-500',
    },
    {
      title: 'Paramètres hérités',
      description: 'Réglages de l’ancien Wplacer (sans effet sur la simulation)',
      icon: '/icons/settings.svg',
      path: '/settings',
      color: 'border-gray-500',
    },
  ];

  return (
    <>
      <h1 className="text-3xl font-bold">Tableau de bord</h1>
      <p className="text-muted-foreground mb-4">GeoPlacer V1 : moteur sur une toile simulée locale.</p>
      <SimulationDashboard />
      <h2 className="mt-8 mb-3 text-xl font-semibold">Autres pages</h2>
      <div className="grid grid-cols-2 gap-4">
        {quickActions.map((action) => (
          <Card
            key={action.path}
            className="cursor-pointer transition-all hover:shadow-md hover:scale-105"
            onClick={() => navigate(action.path)}
          >
            <CardHeader>
              <div className={`border-l-4 ${action.color} pl-3`}>
                <div className="flex items-center gap-3 mb-2">
                  <img 
                    src={action.icon} 
                    alt="" 
                    className="w-8 h-8"
                  />
                  <CardTitle>{action.title}</CardTitle>
                </div>
              </div>
              <CardDescription className="pl-3">{action.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </>
  );
}
