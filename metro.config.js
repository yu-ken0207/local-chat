// 圖鑑的角色原文分片（assets/agents/prompts-NN.txt）當成資源檔，不打包進 JS
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('txt');

module.exports = config;
