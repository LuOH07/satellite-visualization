# 卫星轨道可视化系统

基于Cesium和Flask的卫星轨道与覆盖分析可视化平台。

## 功能特性
- 使用SGP4算法计算真实卫星轨道
- 可视化卫星条带覆盖范围
- 计算特定位置的重访时间
- 交互式三维地球展示

## 快速开始
1. 克隆仓库
2. 安装依赖：`pip install -r requirements.txt`
3. 运行应用：`python app.py`
4. 打开浏览器访问 `http://localhost:5000`

## 依赖
- Python 3.7+
- Flask
- CesiumJS

## 文件说明
- `app.py`：主应用文件
- `orbit_calculations.py`：轨道计算核心
- `satellite.txt`：示例TLE卫星数据