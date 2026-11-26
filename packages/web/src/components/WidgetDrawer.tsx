import { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { WIDGET_CATALOG } from '@orrery/shared';
import type { GridWidgetItem, WidgetType } from '@orrery/shared';
import { Dialog, widgetIcons } from './Telemetry';

export function WidgetDrawer({ items, addWidget, onClose }: {
  items: GridWidgetItem[]; addWidget: (type: WidgetType) => string | undefined; onClose: () => void;
}) {
  const [message, setMessage] = useState('');
  return <Dialog title="添加组件" className="widget-drawer" onClose={onClose}>
    <div className="drawer-list">{Object.values(WIDGET_CATALOG).map(meta => {
      const present = items.some(i => i.type === meta.type);
      const Icon = widgetIcons[meta.type];
      return <button key={meta.type} className="drawer-option" disabled={present} onClick={() => {
        const error = addWidget(meta.type);
        if (error) setMessage(error);
        else onClose();
      }}>
        <Icon size={18} /><span className="drawer-copy"><strong>{meta.title}</strong><small>{meta.description}</small></span>
        <span className="drawer-state">{present ? <Check size={13} /> : <Plus size={13} />}{present ? '已添加' : '可添加'}</span>
      </button>;
    })}</div>
    {message && <p className="drawer-message" role="status">{message}</p>}
  </Dialog>;
}
