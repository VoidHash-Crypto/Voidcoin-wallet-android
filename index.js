import './bugsnag';
import './gesture-handler';
import 'react-native-get-random-values';
import './shim.js';

import React, { useEffect } from 'react';
import { AppRegistry, LogBox } from 'react-native';

import VoidApp from './VoidApp';

if (!Error.captureStackTrace) {
  // captureStackTrace is only available when debugging
  Error.captureStackTrace = () => {};
}

LogBox.ignoreLogs([
  'Require cycle:',
  'Battery state `unknown` and monitoring disabled, this is normal for simulators and tvOS.',
  'Open debugger to view warnings.',
  'Non-serializable values were found in the navigation state',
]);

AppRegistry.registerComponent('BlueWallet', () => VoidApp);
