// nn.ts — TS 侧神经网络推理封装（ONNX Runtime，训练/部署共用同一模型）
import * as ort from 'onnxruntime-node';
import type { GameState } from '@dl/shared';
import { TILE_FEATURES, type EncodedState } from './encode.js';

export interface NetworkOutput {
  /** 策略 logits（长度 nTiles×38+1，与 actions.ts 索引布局一致；未做 softmax/掩码） */
  policy: Float32Array;
  /** 价值（当前行动方视角，tanh ∈ [-1,1]） */
  value: number;
}

export class NeuralNet {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(onnxPath: string): Promise<NeuralNet> {
    const session = await ort.InferenceSession.create(onnxPath, {
      executionProviders: ['cpu'],
    });
    return new NeuralNet(session);
  }

  /** 单样本前向（batch 1）。enc = 编码后的状态（CLS + 每格 token）。 */
  async forward(state: GameState, enc: EncodedState): Promise<NetworkOutput> {
    const n = enc.tiles.length;
    const S = n + 1; // CLS + nTiles

    // features (1,S,14) 行主序：token i 的 14 维位于 offset i*14
    const features = new Float32Array(S * TILE_FEATURES);
    features.set(enc.cls, 0);
    for (let i = 0; i < n; i++) features.set(enc.tiles[i], (i + 1) * TILE_FEATURES);

    // rows/cols（token 0 = CLS 位置 0；token i>0 = tile i-1）
    const rows = new Float32Array(S);
    const cols = new Float32Array(S);
    for (let i = 1; i < S; i++) {
      const tile = i - 1;
      rows[i] = Math.floor(tile / state.columns);
      cols[i] = tile % state.columns;
    }
    const mask = new Float32Array(S).fill(1);

    const out = await this.session.run({
      features: new ort.Tensor('float32', features, [1, S, TILE_FEATURES]),
      rows: new ort.Tensor('float32', rows, [1, S]),
      cols: new ort.Tensor('float32', cols, [1, S]),
      mask: new ort.Tensor('float32', mask, [1, S]),
    });
    return {
      policy: out.policy.data as Float32Array,
      value: (out.value.data as Float32Array)[0],
    };
  }
}
