# model.py — v2 网络：全格 token Transformer（决策定稿 §4）
#
# 输入（B=批量，S=序列长 = 1(CLS) + nTiles）：
#   features (B,S,14)  每格 14 维特征 + CLS 14 维全局特征（见 docs/阶段0-环境接口规范.md）
#   rows/cols (B,S)    每 token 的行/列（CLS = 0；float32 输入，内部转 int64）
#   mask (B,S)         1 = 真实 token，0 = padding（float32）
#
# 位置编码：仅相对位置偏置（决策定稿 §3）——无绝对位置嵌入，任意地图尺寸通用；
#   tile-tile 偏置按（源行奇偶, Δrow, Δcol）查表（hex 邻接模式随行奇偶变化），
#   CLS 与 tile 之间的偏置用独立的每头标量桶。
#
# 输出：
#   policy (B, nTiles*38+1)  每格 6 方向 + 32 加点（每格交错）+ 末尾切换阶段，与 TS actions.ts 索引布局一致
#   value (B,)               tanh ∈ [-1,1]，当前行动方视角胜率
import math
import torch
import torch.nn as nn
import torch.nn.functional as F

TILE_FEATURES = 14
CLS_FEATURES = 14
DIRS_PER_TILE = 6
ADD_AMOUNT_MAX = 32
ACTIONS_PER_TILE = DIRS_PER_TILE + ADD_AMOUNT_MAX  # 38
BIAS_WINDOW = 8  # 相对位置裁剪窗口（地图最大 15×17，Δ 裁剪到 ±8 足够邻接区分）
BIAS_SIZE = 2 * BIAS_WINDOW + 1


class RelativeBiasAttention(nn.Module):
    def __init__(self, d_model: int, heads: int):
        super().__init__()
        self.heads = heads
        self.d_head = d_model // heads
        self.qkv = nn.Linear(d_model, 3 * d_model)
        self.out = nn.Linear(d_model, d_model)
        # 相对偏置表：heads × 2(源行奇偶) × (2W+1) × (2W+1)
        self.bias_table = nn.Parameter(torch.zeros(heads, 2, BIAS_SIZE, BIAS_SIZE))
        # CLS 桶：CLS→tile 与 tile→CLS 各一个每头标量
        self.cls_out = nn.Parameter(torch.zeros(heads))
        self.cls_in = nn.Parameter(torch.zeros(heads))
        nn.init.normal_(self.bias_table, std=0.1)
        nn.init.normal_(self.cls_out, std=0.1)
        nn.init.normal_(self.cls_in, std=0.1)

    def forward(self, x: torch.Tensor, row: torch.Tensor, col: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        B, S, D = x.shape
        qkv = self.qkv(x).view(B, S, 3, self.heads, self.d_head).permute(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]  # (B,H,S,d)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.d_head)  # (B,H,S,S)

        # tile-tile 相对偏置（含 CLS 行/列，随后被 CLS 桶覆盖）
        row_l, col_l = row.long(), col.long()
        dr = torch.clamp(row_l[:, :, None] - row_l[:, None, :], -BIAS_WINDOW, BIAS_WINDOW) + BIAS_WINDOW
        dc = torch.clamp(col_l[:, :, None] - col_l[:, None, :], -BIAS_WINDOW, BIAS_WINDOW) + BIAS_WINDOW
        parity = row_l[:, :, None] % 2  # 源行奇偶 (B,S,1)
        flat = (parity * BIAS_SIZE * BIAS_SIZE + dr * BIAS_SIZE + dc).long()  # (B,S,S)
        tbl = self.bias_table.view(1, self.heads, -1).expand(B, self.heads, -1)  # (B,H,K)
        idx = flat.unsqueeze(1).expand(B, self.heads, S, S)  # (B,H,S,S)
        # 二维 gather：按 (B×H) 各自从 K 长表中取 (S×S) 个偏置
        bias = torch.gather(
            tbl.reshape(B * self.heads, -1),
            dim=1,
            index=idx.reshape(B * self.heads, -1),
        ).view(B, self.heads, S, S)

        # CLS 桶覆盖（CLS 恒为 token 0）
        bias[:, :, 0, :] = bias[:, :, 0, :] + self.cls_out.view(1, self.heads, 1)
        bias[:, :, :, 0] = bias[:, :, :, 0] + self.cls_in.view(1, self.heads, 1)

        att = att + bias
        key_mask = mask[:, None, None, :] > 0.5  # (B,1,1,S)
        att = att.masked_fill(~key_mask, float('-inf'))
        att = F.softmax(att, dim=-1)
        out = (att @ v).transpose(1, 2).reshape(B, S, D)
        out = self.out(out)
        return out * (mask[:, :, None] > 0.5).float()


class EncoderLayer(nn.Module):
    def __init__(self, d_model: int, heads: int, ffn_dim: int):
        super().__init__()
        self.attn = RelativeBiasAttention(d_model, heads)
        self.norm1 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(nn.Linear(d_model, ffn_dim), nn.GELU(), nn.Linear(ffn_dim, d_model))
        self.norm2 = nn.LayerNorm(d_model)

    def forward(self, x: torch.Tensor, row: torch.Tensor, col: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.norm1(x), row, col, mask)
        x = x + self.ffn(self.norm2(x))
        return x


class NumeralLordNet(nn.Module):
    def __init__(self, d_model: int = 128, layers: int = 6, heads: int = 8, ffn_dim: int = 512):
        super().__init__()
        self.d_model = d_model
        self.embed = nn.Linear(TILE_FEATURES, d_model)
        self.encoders = nn.ModuleList([EncoderLayer(d_model, heads, ffn_dim) for _ in range(layers)])
        self.norm = nn.LayerNorm(d_model)
        self.value_head = nn.Sequential(
            nn.LayerNorm(d_model), nn.Linear(d_model, 32), nn.GELU(), nn.Linear(32, 1)
        )
        self.policy_tile = nn.Linear(d_model, ACTIONS_PER_TILE)
        self.policy_cls = nn.Linear(d_model, 1)

    def forward(
        self,
        features: torch.Tensor,  # (B,S,14)
        rows: torch.Tensor,      # (B,S) float32，0=CLS
        cols: torch.Tensor,      # (B,S) float32
        mask: torch.Tensor,      # (B,S) float32，1=真实
    ) -> tuple[torch.Tensor, torch.Tensor]:
        x = self.embed(features)
        for enc in self.encoders:
            x = enc(x, rows, cols, mask)
        x = self.norm(x)
        cls_tok = x[:, 0]
        value = torch.tanh(self.value_head(cls_tok).squeeze(-1))  # (B,)
        tile_logits = self.policy_tile(x[:, 1:])  # (B, nTiles, 38)
        B, T, _ = tile_logits.shape
        policy = tile_logits.reshape(B, T * ACTIONS_PER_TILE)
        switch_logit = self.policy_cls(cls_tok)  # (B,1)
        policy = torch.cat([policy, switch_logit], dim=1)  # (B, nTiles*38+1)
        return policy, value
