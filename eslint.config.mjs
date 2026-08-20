// ESLint flat config：确定性硬约束（前端规划 §5.4 / P7）
// 作用域：packages/shared/src（reducer 权威逻辑）与 frontend/src/game（前端对局逻辑层）
import tseslint from 'typescript-eslint';

// 浮点字面量（含小数点）参与比较 —— 距离/邻接必须整数运算
const floatLiteral = (side) => `${side}[value=/\\./]`;
const compareOps = '[operator=/^[<>]=?|={1,3}|!==?$/]';

const determinismRules = {
  // 随机与时间一律来自服务器下发的 seed/意图流
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'reducer 禁用随机：随机源只能来自服务器下发（P7）' },
    { object: 'Date', property: 'now', message: 'reducer 禁用本地时钟（P7）' },
    { object: 'performance', property: 'now', message: 'reducer 禁用本地时钟（P7）' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'NewExpression[callee.name=\'Date\']',
      message: 'reducer 禁用 new Date()（P7）',
    },
    {
      selector: `BinaryExpression${compareOps}[left.type='Literal']${floatLiteral('left')}`,
      message: '禁用浮点字面量比较：距离/邻接用整数 axial 运算（P7）',
    },
    {
      selector: `BinaryExpression${compareOps}[right.type='Literal']${floatLiteral('right')}`,
      message: '禁用浮点字面量比较：距离/邻接用整数 axial 运算（P7）',
    },
    {
      // Array#sort 无 comparator 依赖引擎默认排序稳定性
      selector: "CallExpression[callee.property.name='sort'][arguments.length=0]",
      message: '排序必须带全序 comparator（P7）',
    },
  ],
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'backend/data/**', 'gui-test-screenshots/**'] },
  {
    files: ['packages/shared/src/**/*.ts', 'frontend/src/game/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
  },
  // 对局逻辑层：确定性硬约束
  {
    files: ['packages/shared/src/game/**/*.ts', 'frontend/src/game/**/*.ts'],
    rules: determinismRules,
  },
);
