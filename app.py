from flask import Flask, render_template, jsonify, request, send_from_directory
import os
import sys
import json
import traceback
from datetime import datetime, timedelta
import logging
import math

# 导入轨道计算模块
try:
    from orbit_calculations import calculate_realistic_orbit_with_footprint
except ImportError as e:
    print(f"警告: 无法导入orbit_calculations模块: {e}")
    # 创建一个虚拟函数以避免导入错误
    def calculate_realistic_orbit_with_footprint(satellites, side_angle=20):
        return []

app = Flask(__name__, 
    template_folder='templates',
    static_folder='static',
    static_url_path='/static'
)

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Cesium访问令牌 - 请确保这是有效的令牌
CESIUM_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIxNGRhYWIwZC04NWViLTRmZGQtYjUzYi0wNWZkOWIwZjk2ODYiLCJpZCI6Mjg0NzE1LCJpYXQiOjE3NDIxMjQxMzd9.1L80F32tScGa1qLa3-3dlUf9sNPYgAR4tAuCK9qxrNY"

# 模型URL - 使用一个可靠的卫星模型
MODEL_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Duck/glTF/Duck.gltf"

def get_satellite_file_path():
    """获取卫星数据文件路径"""
    possible_paths = [
        'satellite.txt',
        os.path.join(os.path.dirname(__file__), 'satellite.txt'),
        os.path.join(os.getcwd(), 'satellite.txt'),
    ]

    for path in possible_paths:
        if os.path.exists(path):
            logger.info(f"找到卫星数据文件: {path}")
            return path

    logger.warning("未找到卫星数据文件")
    return None

def read_satellite_data():
    """读取卫星TLE数据"""
    tle_file_path = get_satellite_file_path()

    if not tle_file_path:
        logger.error("卫星数据文件不存在")
        return []

    satellites = []
    try:
        with open(tle_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        # 清理数据
        lines = [line.strip() for line in lines if line.strip()]

        logger.info(f"读取到 {len(lines)} 行数据")

        # 处理每三行一组的数据
        for i in range(0, len(lines), 3):
            if i + 2 < len(lines):
                name = lines[i].strip()
                line1 = lines[i + 1].strip()
                line2 = lines[i + 2].strip()

                # 验证TLE格式
                if line1.startswith('1 ') and line2.startswith('2 '):
                    satellites.append({
                        'name': name,
                        'line1': line1,
                        'line2': line2,
                        'id': len(satellites) + 1
                    })
                    logger.info(f"解析卫星: {name}")

        logger.info(f"成功解析 {len(satellites)} 颗卫星")

    except Exception as e:
        logger.error(f"读取卫星数据文件错误: {e}")
        traceback.print_exc()

    return satellites


@app.route('/')
def index():
    """主页面"""
    satellites = read_satellite_data()
    current_time = datetime.now()
    current_time_iso = current_time.strftime('%Y-%m-%dT%H:%M')

    logger.info(f"渲染页面，卫星数量: {len(satellites)}")

    return render_template('index.html',
                           satellites=satellites,
                           current_time_iso=current_time_iso,
                           cesium_token=CESIUM_TOKEN,
                           model_url=MODEL_URL)

@app.route('/get_satellite_data')
def get_satellite_data():
    """获取卫星位置数据 - 使用SGP4和footprint计算"""
    try:
        satellites = read_satellite_data()

        valid_tle_satellites = [sat for sat in satellites if 'line1' in sat and 'line2' in sat]

        logger.info(f"有效TLE卫星数量: {len(valid_tle_satellites)}")

        if not valid_tle_satellites:
            logger.warning("没有有效的TLE数据")
            return jsonify([])

        # 获取侧摆角度参数
        side_angle = request.args.get('side_angle', default=20, type=float)

        # 使用导入的模块函数进行计算
        satellite_data = calculate_realistic_orbit_with_footprint(valid_tle_satellites, side_angle)
        
        # 添加统计信息
        for i, sat in enumerate(satellite_data):
            sat['id'] = i + 1
            sat['color_index'] = i % 10  # 用于前端颜色选择
        
        return jsonify(satellite_data)

    except Exception as e:
        logger.error(f"计算卫星轨道时发生错误: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/calculate_revisit_time')
def api_calculate_revisit_time():
    """API接口：计算重访时间"""
    try:
        latitude = request.args.get('latitude', type=float)
        longitude = request.args.get('longitude', type=float)
        duration = request.args.get('duration', default=24, type=int)
        side_angle = request.args.get('side_angle', default=20, type=float)
        
        if latitude is None or longitude is None:
            return jsonify({'error': '缺少经纬度参数'}), 400
        
        # 验证经纬度范围
        if not (-90 <= latitude <= 90):
            return jsonify({'error': '纬度应在-90到90之间'}), 400
        if not (-180 <= longitude <= 180):
            return jsonify({'error': '经度应在-180到180之间'}), 400
        
        satellites = read_satellite_data()
        valid_tle_satellites = [sat for sat in satellites if 'line1' in sat and 'line2' in sat]
        
        if not valid_tle_satellites:
            return jsonify({'error': '没有有效的卫星数据'}), 400
        
        # 计算卫星轨道数据
        satellite_data = calculate_realistic_orbit_with_footprint(valid_tle_satellites, side_angle)
        
        # 计算覆盖时间
        start_time = datetime.utcnow()
        coverage_times = []
        
        for sat in satellite_data:
            positions = sat['positions']
            total_points = len(positions) // 3
            time_step = duration * 3600 / total_points
            
            # 查询点位置
            query_point_lon = longitude
            query_point_lat = latitude
            
            for i in range(0, len(positions), 3):
                sat_lon = positions[i]
                sat_lat = positions[i + 1]
                
                # 计算大圆距离（简化版）
                lat1_rad = math.radians(query_point_lat)
                lon1_rad = math.radians(query_point_lon)
                lat2_rad = math.radians(sat_lat)
                lon2_rad = math.radians(sat_lon)
                
                dlon = lon2_rad - lon1_rad
                dlat = lat2_rad - lat1_rad
                
                a = math.sin(dlat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon/2)**2
                c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
                distance = 6371 * c  # 地球半径约6371km
                
                # 如果距离小于1000km，认为有覆盖
                if distance < 1000:
                    time_offset = (i // 3) * time_step
                    coverage_time = start_time + timedelta(seconds=time_offset)
                    
                    coverage_times.append({
                        'satellite': sat['name'],
                        'time': coverage_time.isoformat(),
                        'distance_km': distance,
                        'satellite_position': {
                            'longitude': sat_lon,
                            'latitude': sat_lat,
                            'altitude': positions[i + 2]
                        }
                    })
        
        # 按时间排序
        coverage_times.sort(key=lambda x: x['time'])
        
        # 计算重访时间统计
        revisit_stats = {
            'total_coverage_events': len(coverage_times),
            'coverage_times': coverage_times[:20],  # 只返回前20个事件
            'query_point': {
                'latitude': latitude,
                'longitude': longitude
            },
            'duration_hours': duration,
            'side_angle_degrees': side_angle
        }
        
        # 如果有覆盖事件，计算统计信息
        if coverage_times:
            # 计算平均重访时间
            if len(coverage_times) > 1:
                time_diffs = []
                for i in range(1, len(coverage_times)):
                    t1 = datetime.fromisoformat(coverage_times[i-1]['time'].replace('Z', '+00:00'))
                    t2 = datetime.fromisoformat(coverage_times[i]['time'].replace('Z', '+00:00'))
                    diff_hours = (t2 - t1).total_seconds() / 3600
                    time_diffs.append(diff_hours)
                
                revisit_stats.update({
                    'average_revisit_hours': sum(time_diffs) / len(time_diffs),
                    'min_revisit_hours': min(time_diffs) if time_diffs else 0,
                    'max_revisit_hours': max(time_diffs) if time_diffs else 0,
                    'coverage_percentage': (len(coverage_times) / (len(satellite_data) * total_points)) * 100
                })
            else:
                revisit_stats.update({
                    'average_revisit_hours': 0,
                    'min_revisit_hours': 0,
                    'max_revisit_hours': 0,
                    'coverage_percentage': 0
                })
        
        return jsonify(revisit_stats)
        
    except Exception as e:
        logger.error(f"计算重访时间时发生错误: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/health')
def api_health():
    """健康检查接口"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'satellite_file_exists': get_satellite_file_path() is not None,
        'satellite_count': len(read_satellite_data())
    })

@app.route('/api/coverage_analysis')
def api_coverage_analysis():
    """覆盖分析接口"""
    try:
        # 获取参数
        bbox = request.args.get('bbox')  # 格式: minLon,minLat,maxLon,maxLat
        resolution = request.args.get('resolution', default=0.5, type=float)  # 度
        
        if not bbox:
            return jsonify({'error': '缺少bbox参数'}), 400
        
        try:
            bbox_coords = [float(coord) for coord in bbox.split(',')]
            if len(bbox_coords) != 4:
                raise ValueError
        except:
            return jsonify({'error': 'bbox参数格式错误，应为minLon,minLat,maxLon,maxLat'}), 400
        
        min_lon, min_lat, max_lon, max_lat = bbox_coords
        
        # 读取卫星数据
        satellites = read_satellite_data()
        valid_tle_satellites = [sat for sat in satellites if 'line1' in sat and 'line2' in sat]
        
        if not valid_tle_satellites:
            return jsonify({'error': '没有有效的卫星数据'}), 400
        
        side_angle = request.args.get('side_angle', default=20, type=float)
        satellite_data = calculate_realistic_orbit_with_footprint(valid_tle_satellites, side_angle)
        
        # 简化分析：计算每个网格点的覆盖次数
        # 这里只是一个示例，实际应用中需要更复杂的算法
        analysis_result = {
            'bbox': bbox_coords,
            'resolution_degrees': resolution,
            'grid_coverage': [],
            'total_coverage_percentage': 0,
            'max_coverage_count': 0
        }
        
        return jsonify(analysis_result)
        
    except Exception as e:
        logger.error(f"覆盖分析时发生错误: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# 静态文件路由 - 使用正确的路由定义
@app.route('/static/<path:filename>')
def serve_static(filename):
    """提供静态文件"""
    return send_from_directory('static', filename)

@app.route('/favicon.ico')
def favicon():
    """网站图标"""
    return send_from_directory('static', 'favicon.ico', mimetype='image/vnd.microsoft.icon')

@app.errorhandler(404)
def not_found(error):
    """404错误处理"""
    return jsonify({'error': '请求的资源不存在'}), 404

@app.errorhandler(500)
def internal_error(error):
    """500错误处理"""
    logger.error(f"服务器内部错误: {error}")
    return jsonify({'error': '服务器内部错误'}), 500

def setup_app():
    """应用设置"""
    # 确保必要的目录存在
    os.makedirs('static/js', exist_ok=True)
    os.makedirs('static/css', exist_ok=True)
    os.makedirs('templates', exist_ok=True)
    
    # 检查卫星数据文件
    tle_path = get_satellite_file_path()
    if tle_path:
        logger.info(f"卫星数据文件: {tle_path}")
    else:
        logger.warning("未找到卫星数据文件，系统可能无法正常工作")
    
    # 检查模板文件
    template_path = os.path.join('templates', 'index.html')
    if not os.path.exists(template_path):
        logger.info(f"创建模板文件: {template_path}")
        with open(template_path, 'w', encoding='utf-8') as f:
            f.write("""<!DOCTYPE html>
<html>
<head>
    <title>卫星轨道可视化系统</title>
</head>
<body>
    <h1>卫星轨道可视化系统</h1>
    <p>系统正在初始化...</p>
</body>
</html>""")
    
    # 检查静态文件
    css_file = os.path.join('static', 'css', 'styles.css')
    if not os.path.exists(css_file):
        logger.info(f"创建CSS文件: {css_file}")
        with open(css_file, 'w', encoding='utf-8') as f:
            f.write("""/* CSS文件将在此处加载 */""")
    
    js_file = os.path.join('static', 'js', 'app.js')
    if not os.path.exists(js_file):
        logger.info(f"创建JS文件: {js_file}")
        with open(js_file, 'w', encoding='utf-8') as f:
            f.write("// JS文件将在此处加载")

if __name__ == '__main__':
    print("=" * 60)
    print("卫星轨道可视化系统")
    print("=" * 60)
    print(f"Python版本: {sys.version}")
    print(f"工作目录: {os.getcwd()}")
    
    # 获取Flask版本
    try:
        import flask
        print(f"Flask版本: {flask.__version__}")
    except AttributeError:
        print("Flask版本: 未知 (无法获取版本信息)")
    
    # 执行应用设置
    setup_app()
    
    # 检查必要的文件
    print("\n=== 文件检查 ===")
    
    # 检查模板文件
    template_files = [
        ('templates/index.html', 'HTML模板'),
        ('static/css/styles.css', 'CSS样式文件'),
        ('static/js/app.js', 'JavaScript文件'),
        ('satellite.txt', '卫星数据文件'),
        ('orbit_calculations.py', '轨道计算模块'),
    ]
    
    for file_path, description in template_files:
        if os.path.exists(file_path):
            print(f"✓ {description}: {file_path}")
        else:
            print(f"✗ 缺少 {description}: {file_path}")
    
    print("主页面: http://localhost:5000")
    print("卫星数据API: http://localhost:5000/get_satellite_data")
    print("健康检查: http://localhost:5000/api/health")

    # 运行应用
    app.run(
        debug=True,
        host='0.0.0.0',
        port=5000,
        use_reloader=False,
        threaded=True
    )