// TooltipMenu stub — @react-native-menu/menu removed for VoidCoin build
import React from 'react';
import { TouchableOpacity, View } from 'react-native';

interface MenuAction {
  id: string;
  title: string;
}

interface Props {
  title?: string;
  actions?: MenuAction[];
  onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  children?: React.ReactNode;
  isAnchoredToRight?: boolean;
  style?: object;
}

const TooltipMenu: React.FC<Props> = ({ children, onPressAction, actions }) => {
  return (
    <TouchableOpacity onPress={() => {
      if (onPressAction && actions && actions.length > 0) {
        onPressAction({ nativeEvent: { event: actions[0].id } });
      }
    }}>
      <View>{children}</View>
    </TouchableOpacity>
  );
};

export default TooltipMenu;
