import { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardContent } from './ui';

interface Template {
  id: string;
  name: string;
  running: boolean;
  userIds: string[];
  coords: { tx: number; ty: number; px: number; py: number };
}

const START_DISABLED = 'Starting is disabled in GeoPlacer: the inherited drawing engine is not used (the new engine runs on the local simulator only).';

const POLLING_INTERVAL_ACTIVE = 10000; // 10 seconds when templates are running
const POLLING_INTERVAL_IDLE = 30000; // 30 seconds when all templates are stopped

export default function ManageTemplates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Record<string, Template>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const getPollingInterval = () => {
    const templateList = Object.values(templates);
    const hasRunningTemplates = templateList.some(t => t.running);
    return hasRunningTemplates ? POLLING_INTERVAL_ACTIVE : POLLING_INTERVAL_IDLE;
  };

  const setupPolling = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    const interval = getPollingInterval();
    intervalRef.current = setInterval(fetchTemplates, interval);
  };

  useEffect(() => {
    fetchTemplates();
    setupPolling();
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // Update polling interval when template running states change
  useEffect(() => {
    setupPolling();
  }, [templates]);

  const fetchTemplates = async () => {
    try {
      const response = await axios.get('/templates');
      setTemplates(response.data);
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    }
  };

  // F12 (GeoPlacer): starting a template would run the inherited drawing
  // engine against a real service, which this project does not do: starting
  // is disabled. Stopping stays possible (the safe direction), through the
  // route the server really has: PUT /template/:id { running: false }.
  const stopTemplate = (templateId: string) => axios.put(`/template/${templateId}`, { running: false });

  const handleStopAll = async () => {
    try {
      await Promise.all(Object.values(templates).filter((t) => t.running).map((t) => stopTemplate(t.id)));
      fetchTemplates();
    } catch (error) {
      console.error('Failed to stop all templates:', error);
    }
  };

  const handleStopTemplate = async (templateId: string) => {
    try {
      await stopTemplate(templateId);
      fetchTemplates();
    } catch (error) {
      console.error('Failed to stop template:', error);
    }
  };

  const handleDeleteTemplate = async (templateId: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return;
    try {
      await axios.delete(`/template/${templateId}`);
      fetchTemplates();
    } catch (error) {
      console.error('Failed to delete template:', error);
    }
  };

  return (
    <div id="manageTemplates" className="space-y-6">
      <h2 className="text-3xl font-bold">Manage Templates</h2>
      <div className="flex flex-wrap gap-2">
        <button className="bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90" onClick={() => navigate('/templates/add')}>
          Add Template
        </button>
        <button className="bg-secondary text-secondary-foreground px-4 py-2 rounded-md opacity-50 cursor-not-allowed" disabled title={START_DISABLED}>
          Start All
        </button>
        <button className="bg-secondary text-secondary-foreground px-4 py-2 rounded-md hover:bg-secondary/80" onClick={handleStopAll}>
          Stop All
        </button>
        <button className="bg-secondary text-secondary-foreground px-4 py-2 rounded-md hover:bg-secondary/80" onClick={() => navigate('/')}>
          Return
        </button>
      </div>
      <p className="text-sm text-muted-foreground" id="startDisabledNotice">{START_DISABLED}</p>
      <div id="templateList" className="grid grid-cols-2 gap-4">
        {Object.entries(templates).map(([id, template]) => (
          <Card key={id}>
            <CardHeader>
              <CardTitle>{template.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">Coords: ({template.coords.tx}, {template.coords.ty})</p>
              <p className="text-sm text-muted-foreground">Users: {template.userIds.length}</p>
              <p className="text-sm font-medium">Status: {template.running ? 'Running' : 'Stopped'}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                {template.running ? (
                  <button className="bg-secondary text-secondary-foreground px-3 py-1 rounded-md hover:bg-secondary/80" onClick={() => handleStopTemplate(id)}>
                    Stop
                  </button>
                ) : (
                  <button className="bg-primary text-primary-foreground px-3 py-1 rounded-md opacity-50 cursor-not-allowed" disabled title={START_DISABLED}>
                    Start
                  </button>
                )}
                <button
                  className="bg-secondary text-secondary-foreground px-3 py-1 rounded-md hover:bg-secondary/80"
                  onClick={() => navigate('/templates/add')}
                >
                  Edit
                </button>
                <button
                  className="bg-destructive text-destructive-foreground px-3 py-1 rounded-md hover:bg-destructive/90"
                  onClick={() => handleDeleteTemplate(id)}
                >
                  Delete
                </button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
