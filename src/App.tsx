// Copyright 2023 Google LLC

import React from 'react';
import { ComponentsProvider, Tabs2, Tab2 } from "@looker/components";
import { ExtensionProvider} from '@looker/extension-sdk-react'
import { hot } from 'react-hot-loader/root'

import { LookerExploreGenerative } from './LookerExploreGenerative'
import { LookerDashboardGenerative } from './LookerDashboardGenerative'

export const App = hot(() => (
  <ExtensionProvider>
    <ComponentsProvider>
      <Tabs2 defaultTabId="explore">
        <Tab2 id="explore" label="Looker Generative Explores">
          <LookerExploreGenerative/>
        </Tab2>
        <Tab2 id="dashboards" label="Looker Generative Insights on Dashboards">
        <LookerDashboardGenerative/>
        </Tab2>
      </Tabs2>
    </ComponentsProvider>
  </ExtensionProvider>
))
