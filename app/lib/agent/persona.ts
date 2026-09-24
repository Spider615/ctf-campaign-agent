// 对外人设只在这里定义：用户提示词告诉模型自己是谁，回复清洗在模型说漏时用它补自我介绍。
export const AGENT_NAME = "小福";
export const AGENT_IDENTITY = "周大福专属智能营销助手Agent";
// 模型复述身份时常加「的」、夹空格或丢掉 Agent，这些说法都按同一个身份原样改回。
export const AGENT_IDENTITY_VARIANTS = /周大福\s*的?\s*专属\s*智能\s*营销\s*助手(?:\s*agent)?/gi;
